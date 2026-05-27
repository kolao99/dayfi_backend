import crypto from 'node:crypto';
import { db } from '../../config/database';
import { PRIMARY_CURRENCY } from './walletModel';
import { convertAmountToUsd } from './fxService';
import { recordWalletActivity } from './walletActivityService';

export { convertAmountToUsd } from './fxService';

export type LedgerSource =
  | 'grey'
  | 'stellar'
  | 'yellowcard'
  | 'flutterwave'
  | 'p2p'
  | 'swap'
  | 'bank_out'
  | 'investment'
  | 'manual'
  | 'card';

export type CreditResult = {
  usdAmount: number;
  rate: number | null;
  walletId: string;
  movementId: string;
  duplicate: boolean;
};

export type DebitResult = {
  walletId: string;
  newBalance: number;
  movementId: string;
};

async function findMovementByKey(
  idempotencyKey: string
): Promise<{ id: string; usd_equivalent: string | number } | null> {
  return db.oneOrNone(
    `SELECT id, usd_equivalent FROM ledger_movements WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
}

/**
 * Idempotent USD credit — all inflows must use this.
 */
export async function creditUsdBalance(params: {
  userId: string;
  walletId: string;
  amount: number;
  fromCurrency: string;
  source: LedgerSource;
  idempotencyKey: string;
  externalReference?: string;
  metadata?: Record<string, unknown>;
}): Promise<CreditResult> {
  const existing = await findMovementByKey(params.idempotencyKey);
  if (existing) {
    return {
      usdAmount: Number(existing.usd_equivalent),
      rate: null,
      walletId: params.walletId,
      movementId: existing.id,
      duplicate: true,
    };
  }

  const { usdAmount, rate } = await convertAmountToUsd(
    params.amount,
    params.fromCurrency
  );

  const movementId = await db.tx(async (t) => {
    const updated = await t.one<{ balance: string }>(
      `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 AND currency = $3
       RETURNING balance`,
      [usdAmount, params.walletId, PRIMARY_CURRENCY]
    );

    const row = await t.one<{ id: string }>(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        params.userId,
        params.walletId,
        usdAmount,
        PRIMARY_CURRENCY,
        usdAmount,
        params.source,
        params.idempotencyKey,
        params.externalReference ?? null,
        JSON.stringify({
          ...(params.metadata ?? {}),
          fromCurrency: params.fromCurrency,
          rate,
          balanceAfter: Number(updated.balance),
        }),
      ]
    );
    return row.id;
  });

  return {
    usdAmount,
    rate,
    walletId: params.walletId,
    movementId,
    duplicate: false,
  };
}

/**
 * Debit USD wallet with idempotency and sufficient-balance check.
 */
export async function debitUsdBalance(params: {
  userId: string;
  walletId: string;
  amountUsd: number;
  source: LedgerSource;
  idempotencyKey: string;
  externalReference?: string;
  metadata?: Record<string, unknown>;
}): Promise<DebitResult> {
  const existing = await findMovementByKey(params.idempotencyKey);
  if (existing) {
    const w = await db.one<{ wallet_id: string; balance: string }>(
      `SELECT wallet_id, balance FROM wallets WHERE wallet_id = $1`,
      [params.walletId]
    );
    return {
      walletId: w.wallet_id,
      newBalance: Number(w.balance),
      movementId: existing.id,
    };
  }

  const amount = Number(params.amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid debit amount');
  }

  const movementId = await db.tx(async (t) => {
    const wallet = await t.oneOrNone<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1 AND user_id = $2 AND currency = $3 FOR UPDATE`,
      [params.walletId, params.userId, PRIMARY_CURRENCY]
    );
    if (!wallet) {
      throw new Error('USD wallet not found');
    }
    if (Number(wallet.balance) < amount) {
      throw new Error('Insufficient USD balance');
    }

    const updated = await t.one<{ balance: string }>(
      `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 RETURNING balance`,
      [amount, params.walletId]
    );

    const row = await t.one<{ id: string }>(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'debit', $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        params.userId,
        params.walletId,
        amount,
        PRIMARY_CURRENCY,
        amount,
        params.source,
        params.idempotencyKey,
        params.externalReference ?? null,
        JSON.stringify({
          ...(params.metadata ?? {}),
          balanceAfter: Number(updated.balance),
        }),
      ]
    );
    return row.id;
  });

  const w = await db.one<{ balance: string }>(
    `SELECT balance FROM wallets WHERE wallet_id = $1`,
    [params.walletId]
  );

  return {
    walletId: params.walletId,
    newBalance: Number(w.balance),
    movementId,
  };
}

export function buildIdempotencyKey(
  source: string,
  externalRef: string
): string {
  return `${source}:${externalRef}`;
}

export function newReference(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Idempotent credit to any currency wallet (PRD four-wallet ledger).
 */
export async function creditWalletBalance(params: {
  userId: string;
  walletId: string;
  amount: number;
  currency: string;
  usdEquivalent: number;
  source: LedgerSource;
  idempotencyKey: string;
  externalReference?: string;
  metadata?: Record<string, unknown>;
}): Promise<CreditResult> {
  const existing = await findMovementByKey(params.idempotencyKey);
  if (existing) {
    return {
      usdAmount: Number(existing.usd_equivalent),
      rate: null,
      walletId: params.walletId,
      movementId: existing.id,
      duplicate: true,
    };
  }

  const currency = String(params.currency).toUpperCase();
  const amount = Number(params.amount);
  const usdEq = Number(params.usdEquivalent);

  const movementId = await db.tx(async (t) => {
    const updated = await t.one<{ balance: string }>(
      `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 AND currency = $3
       RETURNING balance`,
      [amount, params.walletId, currency]
    );

    const row = await t.one<{ id: string }>(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        params.userId,
        params.walletId,
        amount,
        currency,
        usdEq,
        params.source,
        params.idempotencyKey,
        params.externalReference ?? null,
        JSON.stringify({
          ...(params.metadata ?? {}),
          balanceAfter: Number(updated.balance),
        }),
      ]
    );
    return row.id;
  });

  if (params.source !== 'yellowcard') {
    const meta = params.metadata ?? {};
    const assetCode = String(meta.assetCode ?? currency).toUpperCase();
    const txId = params.externalReference
      ? `wt-${String(params.externalReference).replace(/:/g, '-')}`
      : `wt-${movementId}`;
    try {
      await recordWalletActivity({
        userId: params.userId,
        id: txId,
        direction: 'credit',
        amount,
        currency,
        source: params.source,
        title:
          params.source === 'stellar'
            ? `${assetCode} deposit`
            : params.source === 'flutterwave'
              ? 'NGN bank deposit'
              : `${currency} deposit`,
        reason:
          params.source === 'stellar'
            ? `${assetCode} deposit via Stellar`
            : params.source === 'flutterwave'
              ? 'NGN virtual account deposit'
              : `${currency} wallet credit`,
        externalReference: params.externalReference,
        channel:
          params.source === 'stellar'
            ? 'crypto'
            : params.source === 'flutterwave'
              ? 'bank'
              : 'wallet',
        network: params.source === 'stellar' ? 'stellar' : null,
        beneficiaryName: 'Wallet Top Up',
      });
    } catch (err: unknown) {
      console.warn(
        `[creditWalletBalance] wallet activity record skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    usdAmount: usdEq,
    rate: null,
    walletId: params.walletId,
    movementId,
    duplicate: false,
  };
}

/**
 * Debit any currency wallet with idempotency.
 */
export async function debitWalletBalance(params: {
  userId: string;
  walletId: string;
  amount: number;
  currency: string;
  source: LedgerSource;
  idempotencyKey: string;
  externalReference?: string;
  metadata?: Record<string, unknown>;
}): Promise<DebitResult> {
  const existing = await findMovementByKey(params.idempotencyKey);
  if (existing) {
    const w = await db.one<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1`,
      [params.walletId]
    );
    return {
      walletId: params.walletId,
      newBalance: Number(w.balance),
      movementId: existing.id,
    };
  }

  const currency = String(params.currency).toUpperCase();
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid debit amount');
  }

  const movementId = await db.tx(async (t) => {
    const wallet = await t.oneOrNone<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1 AND user_id = $2 AND currency = $3 FOR UPDATE`,
      [params.walletId, params.userId, currency]
    );
    if (!wallet) {
      throw new Error(`${currency} wallet not found`);
    }
    if (Number(wallet.balance) < amount) {
      throw new Error(`Insufficient ${currency} balance`);
    }

    const updated = await t.one<{ balance: string }>(
      `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 RETURNING balance`,
      [amount, params.walletId]
    );

    const { usdAmount } = await convertAmountToUsd(amount, currency);

    const row = await t.one<{ id: string }>(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'debit', $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        params.userId,
        params.walletId,
        amount,
        currency,
        usdAmount,
        params.source,
        params.idempotencyKey,
        params.externalReference ?? null,
        JSON.stringify({
          ...(params.metadata ?? {}),
          balanceAfter: Number(updated.balance),
        }),
      ]
    );
    return row.id;
  });

  const w = await db.one<{ balance: string }>(
    `SELECT balance FROM wallets WHERE wallet_id = $1`,
    [params.walletId]
  );

  return {
    walletId: params.walletId,
    newBalance: Number(w.balance),
    movementId,
  };
}
