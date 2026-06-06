import { ethers } from 'ethers';
import { db } from '../../config/database';
import {
  listEvmChainsForSync,
  resolveEvmChainConfig,
} from '../../config/evmChains';
import {
  buildIdempotencyKey,
  creditWalletBalance,
} from './balanceService';

type WalletRef = {
  wallet_id: string;
  currency: string;
};

export type EvmInflowSyncResult = {
  processed: number;
  credited: number;
  skipped: number;
  errors: string[];
  credits: Array<{
    chain: string;
    assetCode: string;
    currency: string;
    amount: number;
    duplicate: boolean;
    reference: string;
  }>;
};

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const LOG_BLOCK_RANGE = 9_000;

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
];

function padAddress(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

async function ledgerMovementsReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.ledger_movements') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

async function loadEvmDepositAddress(userId: string): Promise<string | null> {
  const row = await db.oneOrNone<{ ethereum_deposit_address: string | null }>(
    `SELECT ethereum_deposit_address FROM wallets
     WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [userId]
  );
  const address = String(row?.ethereum_deposit_address || '').trim();
  return address || null;
}

async function syncChainUsdcInflows(params: {
  userId: string;
  address: string;
  chainKey: string;
  usdWalletId: string;
  walletsByCurrency: Record<string, WalletRef | undefined>;
}): Promise<Pick<EvmInflowSyncResult, 'processed' | 'credited' | 'skipped' | 'errors' | 'credits'>> {
  const result = {
    processed: 0,
    credited: 0,
    skipped: 0,
    errors: [] as string[],
    credits: [] as EvmInflowSyncResult['credits'],
  };

  const chain = resolveEvmChainConfig(params.chainKey);
  if (!chain?.usdc) {
    result.errors.push(`${params.chainKey}: USDC contract not configured`);
    return result;
  }

  try {
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - LOG_BLOCK_RANGE);
    const logs = await provider.getLogs({
      address: chain.usdc,
      topics: [TRANSFER_TOPIC, null, padAddress(params.address)],
      fromBlock,
      toBlock: latest,
    });

    const token = new ethers.Contract(chain.usdc, ERC20_ABI, provider);
    const decimals = Number(await token.decimals());

    for (const log of logs) {
      const parsed = token.interface.parseLog(log);
      if (!parsed) continue;
      const from = String(parsed.args.from || '').toLowerCase();
      if (from === params.address.toLowerCase()) {
        result.skipped += 1;
        continue;
      }

      const amount = Number(ethers.formatUnits(parsed.args.value, decimals));
      if (amount <= 0) {
        result.skipped += 1;
        continue;
      }

      const reference = `evm-in:${params.chainKey}:${log.transactionHash}:${log.index}`;
      const idempotencyKey = buildIdempotencyKey('evm', reference);

      try {
        const credit = await creditWalletBalance({
          userId: params.userId,
          walletId: params.usdWalletId,
          amount,
          currency: 'USD',
          usdEquivalent: amount,
          source: 'evm',
          idempotencyKey,
          externalReference: reference,
          metadata: {
            network: params.chainKey,
            assetCode: 'USDC',
            amount,
            to: params.address,
            from: parsed.args.from?.toString() ?? '',
            txHash: log.transactionHash,
            logIndex: log.index,
          },
        });

        result.processed += 1;
        if (!credit.duplicate) result.credited += 1;
        result.credits.push({
          chain: params.chainKey,
          assetCode: 'USDC',
          currency: 'USD',
          amount,
          duplicate: credit.duplicate,
          reference,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${reference}: ${msg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`${params.chainKey}: ${msg}`);
  }

  return result;
}

/** Mirror inbound EVM USDC (BSC, Arbitrum, Mantle, Sonic, XDC, Ethereum) into USD ledger. */
export async function syncEvmInflowsToLedger(params: {
  userId: string;
  walletsByCurrency: Record<string, WalletRef | undefined>;
}): Promise<EvmInflowSyncResult> {
  const result: EvmInflowSyncResult = {
    processed: 0,
    credited: 0,
    skipped: 0,
    errors: [],
    credits: [],
  };

  const userId = String(params.userId || '').trim();
  if (!userId) return result;

  if (!(await ledgerMovementsReady())) {
    result.errors.push('ledger_movements table missing — run database migrations');
    return result;
  }

  const usdWallet = params.walletsByCurrency.USD;
  if (!usdWallet?.wallet_id) {
    result.errors.push('USD wallet missing');
    return result;
  }

  const address = await loadEvmDepositAddress(userId);
  if (!address) {
    result.errors.push('ethereum_deposit_address not provisioned');
    return result;
  }

  for (const chain of listEvmChainsForSync()) {
    const partial = await syncChainUsdcInflows({
      userId,
      address,
      chainKey: chain.key,
      usdWalletId: usdWallet.wallet_id,
      walletsByCurrency: params.walletsByCurrency,
    });
    result.processed += partial.processed;
    result.credited += partial.credited;
    result.skipped += partial.skipped;
    result.errors.push(...partial.errors);
    result.credits.push(...partial.credits);
  }

  if (result.processed > 0 || result.errors.length > 0) {
    console.info(
      `[syncEvmInflows] user=${userId} address=${address} processed=${result.processed} credited=${result.credited} errors=${result.errors.length}`
    );
  }

  return result;
}

export async function syncAllCryptoInflowsToLedger(params: {
  userId: string;
  walletsByCurrency: Record<string, WalletRef | undefined>;
}): Promise<{
  stellar: import('./cryptoInflowSyncService').StellarInflowSyncResult;
  evm: EvmInflowSyncResult;
}> {
  const { syncStellarInflowsToLedger } = await import('./cryptoInflowSyncService');
  const [stellar, evm] = await Promise.all([
    syncStellarInflowsToLedger(params),
    syncEvmInflowsToLedger(params),
  ]);
  return { stellar, evm };
}
