import crypto from 'node:crypto';
import { db } from '../../config/database';
import { PRIMARY_CURRENCY } from './walletModel';
import { convertAmountToUsd } from './fxService';
import {
  billPayActivityReason,
  billRefundActivityReason,
  buildWalletActivityTxId,
  formatBillCategoryLabel,
  formatBillPayLabel,
  recordWalletActivity,
  USD_BANK_DEPOSIT_REASON,
} from './walletActivityService';

export { convertAmountToUsd } from './fxService';

export type LedgerSource =
  | 'grey'
  | 'stellar'
  | 'evm'
  | 'yellowcard'
  | 'flutterwave'
  | 'p2p'
  | 'swap'
  | 'bank_out'
  | 'investment'
  | 'dayearn'
  | 'dayflow'
  | 'manual'
  | 'card'
  | 'bill_pay';

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
          originalAmount:
            String(params.fromCurrency).toUpperCase() !== PRIMARY_CURRENCY
              ? Number(params.amount)
              : undefined,
          balanceAfter: Number(updated.balance),
        }),
      ]
    );
    return row.id;
  });

  const meta = params.metadata ?? {};
  if (
    params.source === 'manual' &&
    meta.reversal &&
    (meta.categoryCode || meta.billerName || meta.itemName)
  ) {
    const actionLabel = formatBillCategoryLabel(String(meta.categoryCode ?? ''));
    const txId = buildWalletActivityTxId(params.externalReference, movementId);
    try {
      await recordWalletActivity({
        userId: params.userId,
        id: txId,
        direction: 'credit',
        amount: usdAmount,
        currency: PRIMARY_CURRENCY,
        source: 'manual',
        title: `${actionLabel} refund`,
        reason: billRefundActivityReason(meta),
        externalReference: params.externalReference,
        channel: 'wallet',
        status: 'success-collection',
        beneficiaryName: `${actionLabel} refund`,
        accountNumber: String(meta.customerId ?? '').trim() || undefined,
      });
    } catch (err: unknown) {
      console.warn(
        `[creditUsdBalance] bill refund activity record skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } else if (params.source === 'grey') {
    const txId = buildWalletActivityTxId(params.externalReference, movementId);
    try {
      await recordWalletActivity({
        userId: params.userId,
        id: txId,
        direction: 'credit',
        amount: usdAmount,
        currency: PRIMARY_CURRENCY,
        source: 'grey',
        title: 'USD bank deposit',
        reason: USD_BANK_DEPOSIT_REASON,
        externalReference: params.externalReference,
        channel: 'bank',
        status: 'success-collection',
        beneficiaryName: 'Wallet Top Up',
        beneficiaryCountry: 'US',
      });
    } catch (err: unknown) {
      console.warn(
        `[creditUsdBalance] grey deposit activity record skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

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

  if (params.source === 'bill_pay') {
    const meta = params.metadata ?? {};
    const billLabel = formatBillPayLabel(meta);
    const txId = buildWalletActivityTxId(params.externalReference, movementId);
    try {
      await recordWalletActivity({
        userId: params.userId,
        id: txId,
        direction: 'debit',
        amount,
        currency: PRIMARY_CURRENCY,
        source: 'bill_pay',
        title: billLabel,
        reason: billPayActivityReason(meta, String(meta.customerId ?? '')),
        externalReference: params.externalReference,
        channel: 'wallet',
        status: 'success-payment',
        beneficiaryName: billLabel,
        accountType: 'bill',
        accountNumber: String(meta.customerId ?? '').trim() || undefined,
        networkId: String(meta.billerCode ?? '').trim() || undefined,
        beneficiaryCountry: 'NG',
      });
    } catch (err: unknown) {
      console.warn(
        `[debitUsdBalance] bill pay activity record skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    walletId: params.walletId,
    newBalance: Number(w.balance),
    movementId,
  };
}

export type YellowCardReversalResult = {
  reversed: boolean;
  amountUsd?: number;
  duplicate?: boolean;
};

/**
 * Credit back a Yellow Card wallet-funded send when the payout fails.
 * Idempotent — safe to call from webhooks, status sync, and repair jobs.
 */
export async function reverseYellowCardWalletDebit(params: {
  userId: string;
  collectionSequenceId: string;
  reason?: string;
}): Promise<YellowCardReversalResult> {
  const userId = String(params.userId || '').trim();
  const collectionId = String(params.collectionSequenceId || '').trim();
  if (!userId || !collectionId) return { reversed: false };

  const reversalIdempotencyKey = `${buildIdempotencyKey('yc_send', collectionId)}-reversal`;
  const reversalExternalRef = `${collectionId}-reversal`;

  const existingByKey = await findMovementByKey(reversalIdempotencyKey);
  if (existingByKey) {
    return {
      reversed: false,
      duplicate: true,
      amountUsd: Number(existingByKey.usd_equivalent),
    };
  }

  const existingByRef = await db.oneOrNone<{ usd_equivalent: string }>(
    `SELECT usd_equivalent
     FROM ledger_movements
     WHERE user_id = $1
       AND direction = 'credit'
       AND external_reference = $2
       AND COALESCE(metadata->>'reversal', 'false') = 'true'
     LIMIT 1`,
    [userId, reversalExternalRef]
  );
  if (existingByRef) {
    return {
      reversed: false,
      duplicate: true,
      amountUsd: Number(existingByRef.usd_equivalent),
    };
  }

  const debit = await db.oneOrNone<{
    wallet_id: string;
    amount: string;
    usd_equivalent: string;
  }>(
    `SELECT wallet_id, amount, usd_equivalent
     FROM ledger_movements
     WHERE user_id = $1
       AND direction = 'debit'
       AND source = 'yellowcard'
       AND external_reference = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, collectionId]
  );
  if (!debit) return { reversed: false };

  const totalUsd = Number(debit.usd_equivalent ?? debit.amount);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return { reversed: false };

  await creditUsdBalance({
    userId,
    walletId: debit.wallet_id,
    amount: totalUsd,
    fromCurrency: PRIMARY_CURRENCY,
    source: 'yellowcard',
    idempotencyKey: reversalIdempotencyKey,
    externalReference: reversalExternalRef,
    metadata: {
      reversal: true,
      originalReference: collectionId,
      reason: params.reason ?? 'yellowcard_payment_failed',
    },
  });

  console.info(
    `[reverseYellowCardWalletDebit] credited $${totalUsd.toFixed(2)} user=${userId} ref=${collectionId}`
  );

  return { reversed: true, amountUsd: totalUsd };
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
    const activityTitle =
      typeof meta.activityTitle === 'string' ? meta.activityTitle.trim() : '';
    const potName =
      typeof meta.potName === 'string' ? meta.potName.trim() : '';
    const flowTitle =
      typeof meta.flowTitle === 'string' ? meta.flowTitle.trim() : '';
    const txId =
      params.source === 'swap' && params.externalReference
        ? buildWalletActivityTxId(`swap-credit-${params.externalReference}`)
        : buildWalletActivityTxId(params.externalReference, movementId);

    let creditTitle = activityTitle;
    let creditReason = activityTitle;
    let creditBeneficiary = 'Wallet Top Up';
    let creditAccountType: string | undefined;
    let creditAccountNumber: string | undefined;

    if (params.source === 'dayearn' && meta.action === 'withdraw') {
      creditTitle = potName ? `DayEarn · ${potName}` : 'DayEarn withdrawal';
      creditReason = potName
        ? `Withdrawal from ${potName} DayEarn pot`
        : 'Withdrawal from DayEarn pot';
      creditBeneficiary = 'DayEarn';
      creditAccountType = 'dayearn';
      creditAccountNumber = potName || undefined;
    } else if (params.source === 'dayflow' && meta.dayflowAction === 'release') {
      creditTitle = flowTitle ? `DayFlow · ${flowTitle}` : 'DayFlow refund';
      creditReason = flowTitle
        ? `Returned unused funds from ${flowTitle}`
        : 'DayFlow funds returned to wallet';
      creditBeneficiary = 'DayFlow';
      creditAccountType = 'dayflow';
      creditAccountNumber = flowTitle || undefined;
    } else if (
      params.source === 'manual' &&
      meta.reversal &&
      (meta.categoryCode || meta.billerName || meta.itemName)
    ) {
      const actionLabel = formatBillCategoryLabel(String(meta.categoryCode ?? ''));
      creditTitle = `${actionLabel} refund`;
      creditReason = billRefundActivityReason(meta);
      creditBeneficiary = `${actionLabel} refund`;
      creditAccountNumber = String(meta.customerId ?? '').trim() || undefined;
    } else if (params.source === 'grey') {
      creditTitle = `${currency} bank deposit`;
      creditReason = USD_BANK_DEPOSIT_REASON;
    }

    try {
      await recordWalletActivity({
        userId: params.userId,
        id: txId,
        direction: 'credit',
        amount,
        currency,
        source: params.source,
        title:
          creditTitle ||
          (params.source === 'stellar'
            ? `${assetCode} deposit`
            : params.source === 'flutterwave'
              ? 'NGN bank deposit'
              : params.source === 'grey'
                ? `${currency} bank deposit`
                : `${currency} deposit`),
        reason:
          creditReason ||
          (params.source === 'stellar'
            ? `${assetCode} deposit via Stellar`
            : params.source === 'flutterwave'
              ? 'Deposit via NGN bank account'
              : params.source === 'grey'
                ? USD_BANK_DEPOSIT_REASON
                : `${currency} wallet credit`),
        externalReference: params.externalReference,
        channel:
          params.source === 'stellar'
            ? 'crypto'
            : params.source === 'flutterwave' || params.source === 'grey'
              ? 'bank'
              : 'wallet',
        network: params.source === 'stellar' ? 'stellar' : null,
        beneficiaryName:
          params.source === 'swap'
            ? 'Currency conversion'
            : creditBeneficiary,
        accountType: creditAccountType,
        accountNumber: creditAccountNumber,
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

  if (params.source === 'swap') {
    const meta = params.metadata ?? {};
    const activityTitle =
      typeof meta.activityTitle === 'string' ? meta.activityTitle.trim() : '';
    const convertLabel = activityTitle || `Convert ${currency}`;
    const txId = buildWalletActivityTxId(
      `swap-debit-${params.externalReference ?? movementId}`
    );
    try {
      await recordWalletActivity({
        userId: params.userId,
        id: txId,
        direction: 'debit',
        amount,
        currency,
        source: 'swap',
        title: convertLabel,
        reason: convertLabel,
        externalReference: params.externalReference,
        channel: 'wallet',
        beneficiaryName: 'Currency conversion',
      });
    } catch (err: unknown) {
      console.warn(
        `[debitWalletBalance] swap activity record skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    walletId: params.walletId,
    newBalance: Number(w.balance),
    movementId,
  };
}
