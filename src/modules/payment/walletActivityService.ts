import { db } from '../../config/database';
import type { LedgerSource } from './balanceService';

export type WalletActivityDirection = 'credit' | 'debit';

export type RecordWalletActivityParams = {
  userId: string;
  /** Stable id — usually ledger external_reference or movement id */
  id: string;
  direction: WalletActivityDirection;
  amount: number;
  currency: string;
  source: LedgerSource | 'bank_out';
  title: string;
  reason?: string;
  externalReference?: string;
  channel?: 'crypto' | 'bank' | 'wallet';
  network?: 'stellar' | 'ethereum' | null;
  status?: string;
  beneficiaryName?: string;
  accountNumber?: string;
  bankName?: string;
  /** Defaults to now; backfill should pass ledger_movements.created_at */
  timestamp?: Date;
};

function activityKind(
  direction: WalletActivityDirection
): 'deposit' | 'withdrawal' {
  return direction === 'credit' ? 'deposit' : 'withdrawal';
}

function defaultStatus(
  direction: WalletActivityDirection,
  status?: string
): string {
  if (status) return status;
  return direction === 'credit' ? 'success-collection' : 'success-payment';
}

/** Stable wallet_transactions.id for a ledger movement (must match SQL migration backfill). */
export function buildWalletActivityTxId(
  externalReference?: string | null,
  fallbackId?: string
): string {
  const raw = String(externalReference ?? fallbackId ?? '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/:/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
  return `wt-${normalized.slice(0, 80)}`;
}

function channelForSource(
  source: RecordWalletActivityParams['source'],
  channel?: RecordWalletActivityParams['channel']
): 'crypto' | 'bank' | 'wallet' {
  if (channel) return channel;
  if (source === 'stellar') return 'crypto';
  if (source === 'flutterwave') return 'bank';
  if (source === 'bank_out') return 'bank';
  if (source === 'p2p') return 'wallet';
  return 'wallet';
}

/**
 * Mirror ledger credits/debits into wallet_transactions for the mobile history UI.
 * Idempotent on transaction id. Does not replace Yellow Card collection rows.
 */
export async function recordWalletActivity(
  params: RecordWalletActivityParams
): Promise<{ recorded: boolean }> {
  const userId = String(params.userId || '').trim();
  const id =
    String(params.id || '').trim() ||
    buildWalletActivityTxId(params.externalReference);
  if (!userId || !id) return { recorded: false };

  const extRef = params.externalReference?.trim() || null;

  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { recorded: false };

  const currency = String(params.currency).toUpperCase();
  const direction = params.direction;
  const status = defaultStatus(direction, params.status);
  const kind = activityKind(direction);
  const channel = channelForSource(params.source, params.channel);
  const network =
    params.network ??
    (params.source === 'stellar' ? ('stellar' as const) : null);

  const reason =
    params.reason?.trim() ||
    params.title ||
    (direction === 'credit' ? `${currency} deposit` : `${currency} transfer`);

  const existing = await db.oneOrNone<{ id: string }>(
    `SELECT id FROM wallet_transactions WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (existing) return { recorded: false };

  if (extRef) {
    const existingByRef = await db.oneOrNone<{ id: string }>(
      `SELECT id FROM wallet_transactions
       WHERE user_id = $1 AND external_reference = $2 AND ledger_currency = $3
       LIMIT 1`,
      [userId, extRef, currency]
    );
    if (existingByRef) return { recorded: false };
  }

  const recordedAt = params.timestamp ?? new Date();

  let beneficiaryId: string | null = null;
  const beneficiaryName =
    params.beneficiaryName?.trim() ||
    (direction === 'credit' ? 'Wallet Top Up' : 'Recipient');

  if (beneficiaryName) {
    beneficiaryId = `ben-act-${id.slice(0, 40)}`;
    await db.none(
      `INSERT INTO beneficiaries (id, user_id, name, country, phone, address, dob, email, id_number, id_type)
       VALUES ($1, $2, $3, 'NG', '', '', '', '', '', 'individual')
       ON CONFLICT (id) DO NOTHING`,
      [beneficiaryId, userId, beneficiaryName]
    );
  }

  if (direction === 'credit') {
    await db.none(
      `INSERT INTO wallet_transactions (
         id, user_id, beneficiary_id, status, reason,
         receive_amount, receive_channel, receive_network,
         ledger_currency, activity_kind, external_reference, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        userId,
        beneficiaryId,
        status,
        reason,
        amount,
        channel,
        network,
        currency,
        kind,
        extRef,
        recordedAt,
      ]
    );
  } else {
    await db.none(
      `INSERT INTO wallet_transactions (
         id, user_id, beneficiary_id, status, reason,
         send_amount, send_channel, send_network,
         ledger_currency, activity_kind, external_reference, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        userId,
        beneficiaryId,
        status,
        reason,
        amount,
        channel,
        network,
        currency,
        kind,
        extRef,
        recordedAt,
      ]
    );
  }

  return { recorded: true };
}

/** Backfill wallet_transactions rows from ledger_movements (one-time / after deploy). */
export async function backfillWalletActivitiesFromLedger(
  userId?: string
): Promise<{ inserted: number }> {
  const rows = await db.manyOrNone<{
    id: string;
    user_id: string;
    direction: string;
    amount: string;
    currency: string;
    source: string;
    external_reference: string | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, direction, amount, currency, source,
            external_reference, metadata, created_at
     FROM ledger_movements
     WHERE ($1::varchar IS NULL OR user_id = $1)
     ORDER BY created_at ASC`,
    [userId ?? null]
  );

  let inserted = 0;
  for (const row of rows) {
    const meta = row.metadata ?? {};
    const assetCode = String(meta.assetCode ?? row.currency).toUpperCase();
    const isSwap = row.source === 'swap';
    const activityTitle =
      typeof meta.activityTitle === 'string' ? meta.activityTitle.trim() : '';
    const txId =
      isSwap && row.external_reference
        ? buildWalletActivityTxId(
            row.direction === 'credit'
              ? `swap-credit-${row.external_reference}`
              : `swap-debit-${row.external_reference}`
          )
        : buildWalletActivityTxId(row.external_reference, row.id);

    const result = await recordWalletActivity({
      userId: row.user_id,
      id: txId,
      direction: row.direction === 'credit' ? 'credit' : 'debit',
      amount: Number(row.amount),
      currency: row.currency,
      source: row.source as LedgerSource,
      title: isSwap
        ? activityTitle || `Convert ${meta.fromCurrency ?? row.currency}`
        : row.direction === 'credit'
          ? `${assetCode} deposit`
          : `${row.currency} withdrawal`,
      externalReference: row.external_reference ?? undefined,
      channel:
        row.source === 'stellar'
          ? 'crypto'
          : row.source === 'flutterwave'
            ? 'bank'
            : 'wallet',
      network: row.source === 'stellar' ? 'stellar' : null,
      reason: isSwap
        ? activityTitle ||
          `Convert ${meta.fromCurrency ?? ''} → ${meta.toCurrency ?? row.currency}`
        : row.direction === 'credit'
          ? `${assetCode} deposit via ${row.source}`
          : `${row.currency} sent via ${row.source}`,
      beneficiaryName: isSwap
        ? 'Currency conversion'
        : row.direction === 'credit'
          ? 'Wallet Top Up'
          : 'Recipient',
      timestamp: row.created_at,
    });
    if (result.recorded) inserted += 1;
  }

  return { inserted };
}
