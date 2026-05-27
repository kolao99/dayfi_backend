import crypto from 'node:crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import {
  buildIdempotencyKey,
  creditWalletBalance,
} from './balanceService';
import { convertAmountToUsd } from './fxService';

type WalletRef = {
  wallet_id: string;
  currency: string;
};

function isStellarTestnet(): boolean {
  return String(process.env.STELLAR_NETWORK || '')
    .trim()
    .toLowerCase() !== 'public';
}

function horizonUrl(): string {
  const fromEnv = process.env.STELLAR_HORIZON_URL?.trim();
  if (fromEnv) return fromEnv;
  return isStellarTestnet()
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

function toAmount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pickRef(record: Record<string, unknown>): string {
  return String(
    record.id ||
      record.paging_token ||
      record.transaction_hash ||
      record.created_at ||
      crypto.randomUUID()
  );
}

/**
 * Mirror inbound Stellar USDC/EURC payments into internal ledger wallets.
 * This closes the gap where on-chain deposits existed but app wallet balances stayed unchanged.
 */
export async function syncStellarInflowsToLedger(params: {
  userId: string;
  walletsByCurrency: Record<string, WalletRef | undefined>;
}): Promise<{ processed: number; credited: number }> {
  const userId = String(params.userId || '').trim();
  if (!userId) return { processed: 0, credited: 0 };

  const usdWallet = params.walletsByCurrency.USD;
  if (!usdWallet?.wallet_id) return { processed: 0, credited: 0 };

  const row = await db.oneOrNone<{ stellar_deposit_address: string | null }>(
    `SELECT stellar_deposit_address
     FROM wallets
     WHERE user_id = $1 AND currency = 'USD'
     LIMIT 1`,
    [userId]
  );
  const address = String(row?.stellar_deposit_address || '').trim();
  if (!address) return { processed: 0, credited: 0 };

  let records: Record<string, unknown>[] = [];
  try {
    const server = new StellarSdk.Horizon.Server(horizonUrl());
    const page = await server.payments().forAccount(address).limit(200).order('desc').call();
    records = (page.records as unknown as Record<string, unknown>[]) || [];
  } catch {
    return { processed: 0, credited: 0 };
  }

  let processed = 0;
  let credited = 0;

  for (const rec of records) {
    if (String(rec.type || '').toLowerCase() !== 'payment') continue;
    if (String(rec.to || '') !== address) continue;

    const assetType = String(rec.asset_type || '').toLowerCase();
    const assetCode = assetType === 'native'
      ? 'XLM'
      : String(rec.asset_code || '').toUpperCase();
    if (assetCode !== 'USDC' && assetCode !== 'EURC') continue;

    const amount = toAmount(rec.amount);
    if (amount <= 0) continue;

    const targetCurrency = assetCode === 'USDC' ? 'USD' : 'EUR';
    const targetWallet = params.walletsByCurrency[targetCurrency];
    if (!targetWallet?.wallet_id) continue;

    const reference = `stellar-in:${pickRef(rec)}`;
    const idempotencyKey = buildIdempotencyKey('stellar', reference);

    let usdEquivalent = amount;
    if (targetCurrency !== 'USD') {
      try {
        const fx = await convertAmountToUsd(amount, targetCurrency);
        usdEquivalent = Number(fx.usdAmount || amount);
      } catch {
        usdEquivalent = amount;
      }
    }

    const result = await creditWalletBalance({
      userId,
      walletId: targetWallet.wallet_id,
      amount,
      currency: targetCurrency,
      usdEquivalent,
      source: 'stellar',
      idempotencyKey,
      externalReference: reference,
      metadata: {
        network: 'stellar',
        assetCode,
        amount,
        to: address,
        from: String(rec.from || ''),
        txHash: String(rec.transaction_hash || ''),
        operationId: String(rec.id || ''),
      },
    });

    processed += 1;
    if (!result.duplicate) credited += 1;
  }

  return { processed, credited };
}
