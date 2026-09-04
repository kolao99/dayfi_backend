import crypto from 'node:crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import {
  isStellarTestnet,
  resolveEurcIssuer,
  resolveUsdcIssuer,
} from '../../config/stellarIssuers';
import { buildIdempotencyKey, creditWalletBalance } from './balanceService';
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

/**
 * Horizon payment ids look like `19347126861451265`.
 * Effect ids look like `0019347126861451265-0000000001` (same op, padded).
 */
function normalizeHorizonOperationId(id: unknown): string | null {
  const raw = String(id || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    try {
      return BigInt(raw).toString();
    } catch {
      return raw.replace(/^0+/, '') || '0';
    }
  }
  const m = raw.match(/^0*(\d+)-\d+$/);
  if (m) {
    try {
      return BigInt(m[1]).toString();
    } catch {
      return m[1].replace(/^0+/, '') || '0';
    }
  }
  return null;
}

/** Prefer shared Horizon operation id so payment + effect collapse to one credit. */
function pickInflowIdempotencyRef(record: Record<string, unknown>): string {
  const assetType = String(record.asset_type || '').toLowerCase();
  const assetCode =
    assetType === 'native'
      ? 'XLM'
      : String(record.asset_code || '').toUpperCase();
  const amount = toAmount(record.amount);

  const opId = normalizeHorizonOperationId(record.id);
  if (opId) {
    return `op:${opId}:${assetCode}:${amount}`;
  }

  const txHash = String(record.transaction_hash || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(txHash)) {
    return `tx:${txHash}:${assetCode}:${amount}`;
  }

  return pickRef(record);
}

/** All dedup keys for an inflow record (op + tx) so either form skips the other. */
function inflowDedupKeys(record: Record<string, unknown>): string[] {
  const assetType = String(record.asset_type || '').toLowerCase();
  const assetCode =
    assetType === 'native'
      ? 'XLM'
      : String(record.asset_code || '').toUpperCase();
  const amount = toAmount(record.amount);
  const keys: string[] = [];

  const opId = normalizeHorizonOperationId(record.id);
  if (opId) keys.push(`op:${opId}:${assetCode}:${amount}`);

  const txHash = String(record.transaction_hash || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(txHash)) {
    keys.push(`tx:${txHash}:${assetCode}:${amount}`);
  }

  if (!keys.length) keys.push(pickRef(record));
  return keys;
}

function isKnownStablecoinPayment(rec: Record<string, unknown>): boolean {
  const assetType = String(rec.asset_type || '').toLowerCase();
  const assetCode =
    assetType === 'native' ? 'XLM' : String(rec.asset_code || '').toUpperCase();
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

    const paymentTxHashes = new Set(
      records
        .map((r) => String(r.transaction_hash || '').trim().toLowerCase())
        .filter((h) => /^[a-f0-9]{64}$/.test(h))
    );

    // Soroban/SAC USDC may credit the classic trustline without a classic
    // `payment` op. Also ingest matching `account_credited` effects.
    try {
      const effectsPage = await server
        .effects()
        .forAccount(address)
        .limit(200)
        .order('desc')
        .call();
      for (const effect of (effectsPage.records as unknown as Record<
        string,
        unknown
      >[]) || []) {
        if (String(effect.type || '').toLowerCase() !== 'account_credited') {
          continue;
        }
        const effectTx = String(effect.transaction_hash || '')
          .trim()
          .toLowerCase();
        // Already covered by a classic payment for this tx — do not double-ingest.
        if (effectTx && paymentTxHashes.has(effectTx)) {
          continue;
        }
        records.push({
          type: 'payment',
          to: address,
          from: '', // unknown counterparty for SAC; do not self-skip
          amount: effect.amount,
          asset_type: effect.asset_type,
          asset_code: effect.asset_code,
          asset_issuer: effect.asset_issuer,
          transaction_hash: effect.transaction_hash || '',
          id: effect.id,
          paging_token: effect.paging_token,
          created_at: effect.created_at,
        });
      }
    } catch (effectErr: unknown) {
      const msg =
        effectErr instanceof Error ? effectErr.message : String(effectErr);
      console.warn(
        `[syncStellarInflows] effects fetch failed user=${userId}: ${msg}`
      );
    }
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

  const seenRefs = new Set<string>();

  for (const rec of records) {
    if (String(rec.type || '').toLowerCase() !== 'payment') continue;
    if (String(rec.to || '') !== address) continue;
    const fromAddress = String(rec.from || '').trim();
    if (fromAddress && fromAddress === address) {
      result.skipped += 1;
      continue;
    }
    if (!isKnownStablecoinPayment(rec)) continue;

    const assetType = String(rec.asset_type || '').toLowerCase();
    const assetCode =
      assetType === 'native'
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

    const dedupKeys = inflowDedupKeys(rec);
    if (dedupKeys.some((k) => seenRefs.has(k))) {
      result.skipped += 1;
      continue;
    }
    for (const k of dedupKeys) seenRefs.add(k);

    const reference = `stellar-in:${pickInflowIdempotencyRef(rec)}`;
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
      if (!credit.duplicate) {
        const { deliverAzapPush } = await import(
          '../four/finance/azapNotifyService'
        );
        void deliverAzapPush(
          userId,
          `Your ${amount} ${assetCode} deposit has arrived.`
        );
      }
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
