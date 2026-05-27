import crypto from 'node:crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import {
  isStellarTestnet,
  resolveEurcIssuer,
  resolveUsdcIssuer,
} from '../../config/stellarIssuers';
import {
  buildIdempotencyKey,
  creditWalletBalance,
} from './balanceService';
import { convertAmountToUsd } from './fxService';

type WalletRef = {
  wallet_id: string;
  currency: string;
};

export type StellarInflowSyncResult = {
  processed: number;
  credited: number;
  skipped: number;
  errors: string[];
  credits: Array<{
    assetCode: string;
    currency: string;
    amount: number;
    duplicate: boolean;
    reference: string;
  }>;
};

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

function isKnownStablecoinPayment(rec: Record<string, unknown>): boolean {
  const assetType = String(rec.asset_type || '').toLowerCase();
  const assetCode = assetType === 'native'
    ? 'XLM'
    : String(rec.asset_code || '').toUpperCase();
  if (assetCode !== 'USDC' && assetCode !== 'EURC') return false;

  const issuer = String(rec.asset_issuer || '').trim();
  if (!issuer) return false;

  const expected =
    assetCode === 'USDC' ? resolveUsdcIssuer() : resolveEurcIssuer();
  return issuer === expected;
}

/**
 * Mirror inbound Stellar USDC/EURC payments into internal ledger wallets.
 */
async function ledgerMovementsReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.ledger_movements') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

export async function syncStellarInflowsToLedger(params: {
  userId: string;
  walletsByCurrency: Record<string, WalletRef | undefined>;
}): Promise<StellarInflowSyncResult> {
  const result: StellarInflowSyncResult = {
    processed: 0,
    credited: 0,
    skipped: 0,
    errors: [],
    credits: [],
  };

  const userId = String(params.userId || '').trim();
  if (!userId) return result;

  if (!(await ledgerMovementsReady())) {
    result.errors.push(
      'ledger_movements table missing — run database migrations on Railway'
    );
    return result;
  }

  const usdWallet = params.walletsByCurrency.USD;
  if (!usdWallet?.wallet_id) {
    result.errors.push('USD wallet missing');
    return result;
  }

  const row = await db.oneOrNone<{ stellar_deposit_address: string | null }>(
    `SELECT stellar_deposit_address
     FROM wallets
     WHERE user_id = $1 AND currency = 'USD'
     LIMIT 1`,
    [userId]
  );
  const address = String(row?.stellar_deposit_address || '').trim();
  if (!address) {
    result.errors.push('stellar_deposit_address not provisioned');
    return result;
  }

  let records: Record<string, unknown>[] = [];
  try {
    const server = new StellarSdk.Horizon.Server(horizonUrl());
    const page = await server
      .payments()
      .forAccount(address)
      .limit(200)
      .order('desc')
      .call();
    records = (page.records as unknown as Record<string, unknown>[]) || [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[syncStellarInflows] horizon failed user=${userId} address=${address} network=${
        isStellarTestnet() ? 'testnet' : 'mainnet'
      }: ${msg}`
    );
    result.errors.push(`horizon: ${msg}`);
    return result;
  }

  for (const rec of records) {
    if (String(rec.type || '').toLowerCase() !== 'payment') continue;
    if (String(rec.to || '') !== address) continue;
    if (!isKnownStablecoinPayment(rec)) continue;

    const assetType = String(rec.asset_type || '').toLowerCase();
    const assetCode = assetType === 'native'
      ? 'XLM'
      : String(rec.asset_code || '').toUpperCase();

    const amount = toAmount(rec.amount);
    if (amount <= 0) {
      result.skipped += 1;
      continue;
    }

    const targetCurrency = assetCode === 'USDC' ? 'USD' : 'EUR';
    const targetWallet = params.walletsByCurrency[targetCurrency];
    if (!targetWallet?.wallet_id) {
      result.skipped += 1;
      continue;
    }

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

    try {
      const credit = await creditWalletBalance({
        userId,
        walletId: targetWallet.wallet_id,
        amount,
        currency: targetCurrency,
        usdEquivalent,
        source: 'stellar',
        idempotencyKey,
        externalReference: reference,
        metadata: {
          network: isStellarTestnet() ? 'stellar-testnet' : 'stellar-mainnet',
          assetCode,
          amount,
          to: address,
          from: String(rec.from || ''),
          txHash: String(rec.transaction_hash || ''),
          operationId: String(rec.id || ''),
        },
      });

      result.processed += 1;
      if (!credit.duplicate) result.credited += 1;
      result.credits.push({
        assetCode,
        currency: targetCurrency,
        amount,
        duplicate: credit.duplicate,
        reference,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[syncStellarInflows] credit failed user=${userId} ref=${reference}: ${msg}`
      );
      result.errors.push(`${reference}: ${msg}`);
    }
  }

  if (result.processed > 0 || result.errors.length > 0) {
    console.info(
      `[syncStellarInflows] user=${userId} address=${address} processed=${result.processed} credited=${result.credited} errors=${result.errors.length}`
    );
  }

  return result;
}
