import { db } from '../../config/database';
import {
  buildIdempotencyKey,
  debitWalletBalance,
} from './balanceService';
import {
  buildWalletActivityTxId,
  recordWalletActivity,
} from './walletActivityService';

async function loadDepositAddresses(userId: string) {
  return db.oneOrNone<{
    stellar_deposit_address: string | null;
    ethereum_deposit_address: string | null;
  }>(
    `SELECT stellar_deposit_address, ethereum_deposit_address
     FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [userId]
  );
}

function assetToCurrency(asset: string): 'USD' | 'EUR' {
  return asset.toUpperCase() === 'EURC' ? 'EUR' : 'USD';
}

function isSelfTransfer(params: {
  network: string;
  to: string;
  stellar?: string | null;
  ethereum?: string | null;
}): boolean {
  const network = params.network.toLowerCase();
  const to = params.to.trim();
  if (network === 'stellar') {
    return Boolean(params.stellar && params.stellar === to);
  }
  if (network === 'ethereum' || network === 'eth') {
    return Boolean(
      params.ethereum && params.ethereum.toLowerCase() === to.toLowerCase()
    );
  }
  return false;
}

/**
 * Mirror a successful on-chain crypto send into the internal ledger.
 * Skips ledger movement when sending to the user's own deposit address.
 */
export async function recordCryptoOutboundLedger(params: {
  userId: string;
  amount: string;
  asset: string;
  network: string;
  txHash: string;
  to: string;
  from: string;
}): Promise<{ skipped: boolean; newBalance?: number }> {
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid crypto send amount');
  }

  const asset = params.asset.toUpperCase();
  const currency = assetToCurrency(asset);
  const addresses = await loadDepositAddresses(params.userId);

  if (
    isSelfTransfer({
      network: params.network,
      to: params.to,
      stellar: addresses?.stellar_deposit_address,
      ethereum: addresses?.ethereum_deposit_address,
    })
  ) {
    return { skipped: true };
  }

  const wallet = await db.oneOrNone<{ wallet_id: string }>(
    `SELECT wallet_id FROM wallets WHERE user_id = $1 AND currency = $2 LIMIT 1`,
    [params.userId, currency]
  );
  if (!wallet?.wallet_id) {
    throw new Error(`${currency} wallet not found`);
  }

  const reference = `crypto-out:${params.txHash}`;
  const networkKey = params.network.toLowerCase();
  const activityNetwork =
    networkKey === 'ethereum' || networkKey === 'eth' ? 'ethereum' : 'stellar';

  const debit = await debitWalletBalance({
    userId: params.userId,
    walletId: wallet.wallet_id,
    amount,
    currency,
    source: 'stellar',
    idempotencyKey: buildIdempotencyKey('crypto-out', params.txHash),
    externalReference: reference,
    metadata: {
      network: activityNetwork,
      asset,
      txHash: params.txHash,
      to: params.to.trim(),
      from: params.from,
    },
  });

  try {
    await recordWalletActivity({
      userId: params.userId,
      id: buildWalletActivityTxId(reference),
      direction: 'debit',
      amount,
      currency,
      source: 'stellar',
      title: `Send ${asset}`,
      externalReference: reference,
      channel: 'crypto',
      network: activityNetwork,
      beneficiaryName: params.to.trim(),
      accountNumber: params.to.trim(),
      accountType: 'crypto',
      networkId: activityNetwork,
      beneficiaryCountry: currency === 'EUR' ? 'EU' : 'US',
    });
  } catch (err: unknown) {
    console.warn(
      `[recordCryptoOutboundLedger] wallet activity skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return { skipped: false, newBalance: debit.newBalance };
}
