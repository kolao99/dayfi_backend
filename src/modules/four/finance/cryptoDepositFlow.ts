import { upsertActiveIntent } from '../intent/intentService';
import {
  formatCryptoFundingAsk,
  formatUnsupportedCrypto,
  isCryptoDepositSupported,
  parseCryptoDepositUtterance,
  type ParsedCryptoDeposit,
} from '../../azap/capabilities/moneyCapabilities';
import {
  CryptoProvisionError,
  getPersistedCryptoDepositAddresses,
  isUserCryptoWalletReady,
  provisionCryptoWalletsForUser,
} from '../../payment/cryptoWalletProvision';
import {
  getCryptoNetwork,
  resolveDepositAddressForNetwork,
  type CryptoNetworkKey,
  type CryptoStableAsset,
} from '../../../config/cryptoNetworks';
import { deliverAzapPush } from './azapNotifyService';

type CryptoFundingReply = {
  role: 'assistant';
  type: 'text';
  content: string;
};

const PROVISION_TIMEOUT_MS = 5_000;

/** Dedupe background “address ready” pushes while provision is in flight. */
const pendingAddressNotifies = new Map<string, Promise<void>>();

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function notifyKey(
  userId: string,
  asset: string,
  network: string
): string {
  return `${userId}:${asset}:${network}`;
}

export function formatCryptoDepositInstructions(input: {
  asset: CryptoStableAsset;
  network: CryptoNetworkKey;
  address: string;
  amount?: number | null;
  readyPing?: boolean;
}): string {
  const net = getCryptoNetwork(input.network);
  const networkName = net?.name || input.network;
  const rail = net?.rail === 'stellar' ? 'Stellar' : networkName;
  const lines: string[] = [];

  if (input.readyPing) {
    lines.push(`Your ${networkName} deposit address is ready. 🟢`);
    lines.push('');
    lines.push(`*${input.asset} on ${networkName}*`);
  } else if (input.amount != null) {
    lines.push(
      `Sure. 🪙 You're depositing *${input.amount} ${input.asset}* on *${networkName}*.`
    );
  } else {
    lines.push(
      `Sure. 🪙 You're depositing *${input.asset}* on *${networkName}*.`
    );
  }
  lines.push('');
  lines.push('*Your deposit address:*');
  lines.push(`\`${input.address}\``);
  lines.push('');
  lines.push(`Send only ${input.asset} on ${rail} to this address.`);
  lines.push('');

  if (net?.rail === 'stellar') {
    lines.push(
      'No memo is required — this address is unique to your Dayfi wallet.'
    );
    lines.push('');
  } else {
    lines.push(
      'This is your Dayfi EVM deposit address (same for Ethereum, BNB Smart Chain, Arbitrum, and other supported EVM rails).'
    );
    lines.push('');
  }

  lines.push(
    `Only send ${input.asset} on ${networkName}. Other assets or networks may be lost.`
  );
  lines.push(
    'Once the deposit is detected and confirmed, your Dayfi wallet will be updated automatically.'
  );

  if (input.amount == null && !input.readyPing) {
    lines.push('');
    lines.push(
      'How much are you planning to deposit? You can enter an amount or just send it when you are ready.'
    );
  }

  return lines.join('\n');
}

export async function beginCryptoFunding(input: {
  userId: string;
  conversationId: string;
}): Promise<CryptoFundingReply> {
  await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'FUND_CRYPTO',
    status: 'COLLECTING_INFORMATION',
    slots: { method: 'crypto' },
  });
  return {
    role: 'assistant',
    type: 'text',
    content: formatCryptoFundingAsk('asset'),
  };
}

export function isCryptoFundingContinuation(
  text: string,
  activeIntent?: string | null
): boolean {
  if (activeIntent === 'FUND_CRYPTO') return true;
  const parsed = parseCryptoDepositUtterance(text);
  return Boolean(
    parsed.wantsCryptoFunding ||
      parsed.wantsDepositAddress ||
      parsed.asset ||
      parsed.network ||
      parsed.unknownAsset ||
      parsed.unknownNetwork
  );
}

export async function continueCryptoFunding(input: {
  userId: string;
  conversationId: string;
  text: string;
  slots?: Record<string, unknown>;
}): Promise<CryptoFundingReply> {
  const parsed = parseCryptoDepositUtterance(input.text);
  const slots: Record<string, unknown> = {
    method: 'crypto',
    ...(input.slots ?? {}),
  };

  const asset = (parsed.asset ||
    (typeof slots.asset === 'string' ? slots.asset : null) ||
    null) as CryptoStableAsset | null;
  const network = (parsed.network ||
    (typeof slots.network === 'string' ? slots.network : null) ||
    null) as CryptoNetworkKey | null;
  const amount =
    parsed.amount ??
    (typeof slots.amount === 'number' && Number.isFinite(slots.amount)
      ? slots.amount
      : typeof slots.amount === 'string' && Number(slots.amount) > 0
        ? Number(slots.amount)
        : null);

  if (parsed.unknownAsset || (parsed.unknownNetwork && !network)) {
    await persistSlots(input, { ...slots, asset, network, amount });
    return {
      role: 'assistant',
      type: 'text',
      content: formatUnsupportedCrypto({
        asset: parsed.unknownAsset || asset,
        network: parsed.unknownNetwork,
      }),
    };
  }

  if (!asset) {
    await persistSlots(input, { ...slots, asset: null, network, amount });
    return {
      role: 'assistant',
      type: 'text',
      content: formatCryptoFundingAsk('asset'),
    };
  }

  if (!network) {
    await persistSlots(input, { ...slots, asset, network: null, amount });
    return {
      role: 'assistant',
      type: 'text',
      content: formatCryptoFundingAsk('network', asset),
    };
  }

  if (!isCryptoDepositSupported(asset, network)) {
    await persistSlots(input, { ...slots, asset, network: null, amount });
    return {
      role: 'assistant',
      type: 'text',
      content: formatUnsupportedCrypto({
        asset,
        network: getCryptoNetwork(network)?.name || network,
      }),
    };
  }

  const existingAddress =
    typeof slots.depositAddress === 'string' && slots.depositAddress.trim()
      ? String(slots.depositAddress).trim()
      : null;

  // Address already issued — keep AWAITING_DEPOSIT and consume amount / status follow-ups.
  if (existingAddress && asset && network) {
    await upsertActiveIntent({
      userId: input.userId,
      conversationId: input.conversationId,
      intent: 'FUND_CRYPTO',
      status: 'AWAITING_DEPOSIT',
      slots: {
        ...slots,
        method: 'crypto',
        asset,
        network,
        amount,
        depositAddress: existingAddress,
        pendingAddress: false,
      },
    });

    if (parsed.amount != null) {
      const net = getCryptoNetwork(network);
      const networkName = net?.name || network;
      return {
        role: 'assistant',
        type: 'text',
        content:
          `Got it — *${amount} ${asset}* on *${networkName}*.\n\n` +
          `Send it to your deposit address when you're ready:\n\`${existingAddress}\`\n\n` +
          `I'll let you know once Dayfi detects and confirms the deposit.`,
      };
    }

    return {
      role: 'assistant',
      type: 'text',
      content: formatCryptoDepositInstructions({
        asset,
        network,
        address: existingAddress,
        amount,
      }),
    };
  }

  await persistSlots(input, { ...slots, asset, network, amount });
  return issueDepositAddress({
    userId: input.userId,
    conversationId: input.conversationId,
    asset,
    network,
    amount,
  });
}

async function persistSlots(
  input: { userId: string; conversationId: string },
  slots: Record<string, unknown>,
  status: 'COLLECTING_INFORMATION' | 'AWAITING_DEPOSIT' = 'COLLECTING_INFORMATION'
): Promise<void> {
  await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'FUND_CRYPTO',
    status,
    slots,
  });
}

async function persistAwaitingDeposit(
  input: {
    userId: string;
    conversationId: string;
    asset: CryptoStableAsset;
    network: CryptoNetworkKey;
    amount?: number | null;
    address: string;
  }
): Promise<void> {
  await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'FUND_CRYPTO',
    status: 'AWAITING_DEPOSIT',
    slots: {
      method: 'crypto',
      asset: input.asset,
      network: input.network,
      ...(input.amount != null ? { amount: input.amount } : {}),
      depositAddress: input.address,
      pendingAddress: false,
    },
  });
}

async function resolveDayfiDepositAddress(input: {
  userId: string;
  network: CryptoNetworkKey;
  timeoutMs?: number;
}): Promise<string> {
  const net = getCryptoNetwork(input.network);
  const persisted = await getPersistedCryptoDepositAddresses(input.userId);

  // EVM receive only needs the Dayfi EVM address — do not block on Stellar funding.
  if (net?.rail === 'evm' && persisted.evm) {
    return persisted.evm;
  }

  // Idempotent fast path: already-provisioned Dayfi Stellar wallet.
  if (
    net?.rail === 'stellar' &&
    persisted.stellar &&
    (await isUserCryptoWalletReady(input.userId))
  ) {
    return persisted.stellar;
  }

  const provisionPromise = provisionCryptoWalletsForUser(input.userId);
  const provisioned =
    input.timeoutMs != null && input.timeoutMs > 0
      ? await withTimeout(
          provisionPromise,
          input.timeoutMs,
          'crypto wallet provision'
        )
      : await provisionPromise;
  const address = resolveDepositAddressForNetwork(input.network, {
    stellar: provisioned.stellarAddress,
    evm: provisioned.ethereumAddress,
  });
  if (!address) {
    throw new CryptoProvisionError(
      'WALLET_PROVISIONING_ERROR',
      'Deposit address is not ready yet'
    );
  }
  return address;
}

function scheduleDepositAddressReadyNotify(input: {
  userId: string;
  conversationId: string;
  asset: CryptoStableAsset;
  network: CryptoNetworkKey;
  amount?: number | null;
}): void {
  const key = notifyKey(input.userId, input.asset, input.network);
  if (pendingAddressNotifies.has(key)) return;

  const work = (async () => {
    try {
      const address = await resolveDayfiDepositAddress({
        userId: input.userId,
        network: input.network,
        // No short timeout — finish in background.
      });

      await persistAwaitingDeposit({
        userId: input.userId,
        conversationId: input.conversationId,
        asset: input.asset,
        network: input.network,
        amount: input.amount,
        address,
      });

      await deliverAzapPush(
        input.userId,
        formatCryptoDepositInstructions({
          asset: input.asset,
          network: input.network,
          address,
          amount: input.amount,
          readyPing: true,
        })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[azap/crypto-deposit] background address notify failed', msg);
      await deliverAzapPush(
        input.userId,
        `Sorry, I couldn't generate your deposit address right now. Please try again in a moment.`
      );
    }
  })();

  pendingAddressNotifies.set(key, work);
  void work.finally(() => {
    if (pendingAddressNotifies.get(key) === work) {
      pendingAddressNotifies.delete(key);
    }
  });
}

async function issueDepositAddress(input: {
  userId: string;
  conversationId: string;
  asset: CryptoStableAsset;
  network: CryptoNetworkKey;
  amount?: number | null;
}): Promise<CryptoFundingReply> {
  const net = getCryptoNetwork(input.network);
  const networkName = net?.name || input.network;
  const key = notifyKey(input.userId, input.asset, input.network);

  const preparingReply = (): CryptoFundingReply => ({
    role: 'assistant',
    type: 'text',
    content:
      `Preparing your ${input.asset} ${networkName} deposit address… 🪙\n\n` +
      `I'll let you know when it's ready.`,
  });

  if (pendingAddressNotifies.has(key)) {
    return preparingReply();
  }

  // Fast path: Dayfi EVM address already on the wallet row.
  if (net?.rail === 'evm') {
    const persisted = await getPersistedCryptoDepositAddresses(input.userId);
    if (persisted.evm) {
      await persistAwaitingDeposit({
        userId: input.userId,
        conversationId: input.conversationId,
        asset: input.asset,
        network: input.network,
        amount: input.amount,
        address: persisted.evm,
      });
      return {
        role: 'assistant',
        type: 'text',
        content: formatCryptoDepositInstructions({
          asset: input.asset,
          network: input.network,
          address: persisted.evm,
          amount: input.amount,
        }),
      };
    }
  }

  try {
    const address = await resolveDayfiDepositAddress({
      userId: input.userId,
      network: input.network,
      timeoutMs: PROVISION_TIMEOUT_MS,
    });
    if (!address) {
      throw new Error('Deposit address is not ready yet');
    }

    await persistAwaitingDeposit({
      userId: input.userId,
      conversationId: input.conversationId,
      asset: input.asset,
      network: input.network,
      amount: input.amount,
      address,
    });

    return {
      role: 'assistant',
      type: 'text',
      content: formatCryptoDepositInstructions({
        asset: input.asset,
        network: input.network,
        address,
        amount: input.amount,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof CryptoProvisionError ? err.code : undefined;
    console.warn(
      '[azap/crypto-deposit] address provision failed',
      code || 'UNKNOWN',
      msg
    );

    await upsertActiveIntent({
      userId: input.userId,
      conversationId: input.conversationId,
      intent: 'FUND_CRYPTO',
      status: 'COLLECTING_INFORMATION',
      slots: {
        method: 'crypto',
        asset: input.asset,
        network: input.network,
        ...(input.amount != null ? { amount: input.amount } : {}),
        pendingAddress: true,
        ...(code ? { provisionErrorCode: code } : {}),
      },
    });

    if (code === 'MASTER_LIQUIDITY_INSUFFICIENT') {
      return {
        role: 'assistant',
        type: 'text',
        content:
          `Your Stellar deposit address is temporarily unavailable while we're preparing the wallet. Please try again shortly.`,
      };
    }

    if (code === 'TIMEOUT' || /timed out|not ready|incomplete/i.test(msg)) {
      scheduleDepositAddressReadyNotify(input);
      return preparingReply();
    }

    if (
      code === 'STELLAR_PROVIDER_ERROR' ||
      code === 'MASTER_WALLET_NOT_CONFIGURED' ||
      /master wallet|Horizon|MASTER_WALLET/i.test(msg)
    ) {
      scheduleDepositAddressReadyNotify(input);
      return {
        role: 'assistant',
        type: 'text',
        content:
          `Your Stellar deposit address is temporarily unavailable while we're preparing the wallet. Please try again shortly.`,
      };
    }

    return {
      role: 'assistant',
      type: 'text',
      content: `Sorry, I couldn't generate your deposit address right now. Please try again in a moment.`,
    };
  }
}

export function parsedLooksLikeCryptoAnswer(parsed: ParsedCryptoDeposit): boolean {
  return Boolean(
    parsed.asset ||
      parsed.network ||
      parsed.amount ||
      parsed.unknownAsset ||
      parsed.unknownNetwork ||
      parsed.wantsDepositAddress ||
      parsed.wantsCryptoFunding
  );
}

export type CryptoDepositStatus =
  | 'AWAITING_DEPOSIT'
  | 'CONFIRMED'
  | 'CHECK_FAILED';

export async function checkCryptoDepositStatus(input: {
  userId: string;
  asset?: string | null;
  network?: string | null;
  expectedAmount?: number | null;
  depositAddress?: string | null;
}): Promise<{ status: CryptoDepositStatus; content: string }> {
  const asset = String(input.asset || 'USDC').toUpperCase();
  const networkKey = String(input.network || 'stellar').toLowerCase();
  const networkName =
    getCryptoNetwork(networkKey as CryptoNetworkKey)?.name || networkKey;
  const expected =
    input.expectedAmount != null && Number(input.expectedAmount) > 0
      ? Number(input.expectedAmount)
      : null;
  const expectedLabel = expected != null ? `${expected} ${asset}` : asset;

  try {
    // Sync Stellar inflows from Horizon into Dayfi ledger before answering.
    if (networkKey === 'stellar') {
      const PaymentService = (await import('../../payment/services')).default;
      const paymentService = new PaymentService();
      await paymentService.ensureUserLedgerWallets(input.userId);
      const wallets = await paymentService.getWalletsByUserId(input.userId);
      const walletsByCurrency: Record<
        string,
        { wallet_id: string; currency: string } | undefined
      > = {};
      for (const w of wallets as Array<{ wallet_id: string; currency: string }>) {
        const currency = String(w.currency).toUpperCase();
        walletsByCurrency[currency] = {
          wallet_id: w.wallet_id,
          currency,
        };
      }
      const { syncStellarInflowsToLedger } = await import(
        '../../payment/cryptoInflowSyncService'
      );
      await syncStellarInflowsToLedger({
        userId: input.userId,
        walletsByCurrency,
      });
    }

    const { db } = await import('../../../config/database');
    const rows = await db.manyOrNone<{
      amount: string | number;
      usd_equivalent: string | number;
      metadata: Record<string, unknown> | null;
      created_at: Date;
      source: string;
    }>(
      `SELECT amount, usd_equivalent, metadata, created_at, source
         FROM ledger_movements
        WHERE user_id = $1
          AND direction = 'credit'
          AND source IN ('stellar', 'evm')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 25`,
      [input.userId]
    );

    const match = rows.find((row) => {
      const meta = row.metadata || {};
      const metaAsset = String(meta.assetCode || meta.fromCurrency || '')
        .toUpperCase()
        .trim();
      const metaAmount = Number(meta.amount ?? meta.originalAmount ?? row.amount);
      const assetOk =
        !asset ||
        metaAsset === asset ||
        (asset === 'USDC' &&
          (metaAsset === 'USD' || metaAsset === '' || metaAsset === 'USDC'));
      if (!assetOk) return false;
      if (expected == null) return true;
      return Math.abs(metaAmount - expected) < 0.01;
    });

    if (match) {
      const meta = match.metadata || {};
      const confirmedAmount = Number(
        meta.amount ?? meta.originalAmount ?? match.usd_equivalent
      );
      const shown =
        Number.isFinite(confirmedAmount) && confirmedAmount > 0
          ? confirmedAmount
          : expected;
      return {
        status: 'CONFIRMED',
        content:
          `Yes! 🎉 Your *${shown != null ? shown : ''} ${asset}*`.replace(
            /\s+/g,
            ' '
          ).trim() +
          ` deposit has been received and confirmed. Your Dayfi wallet has been updated.`,
      };
    }

    return {
      status: 'AWAITING_DEPOSIT',
      content:
        `Not yet. I haven't received a confirmed *${expectedLabel}* ${networkName} deposit yet. ` +
        `I'll update you when Dayfi detects it` +
        (input.depositAddress
          ? ` at \`${input.depositAddress}\`.`
          : '.'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[azap/crypto-deposit] status check failed', msg);
    return {
      status: 'CHECK_FAILED',
      content:
        `I couldn't check your deposit status right now. Please try again in a moment.`,
    };
  }
}
