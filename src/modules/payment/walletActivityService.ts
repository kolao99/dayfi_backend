import { db } from '../../config/database';
import type { LedgerSource } from './balanceService';

export const NGN_BANK_DEPOSIT_REASON = 'Deposit via NGN bank account';
export const USD_BANK_DEPOSIT_REASON = 'USD bank deposit via wire transfer';

export function formatBillCategoryLabel(code?: string | null): string {
  switch (String(code ?? '').toUpperCase()) {
    case 'AIRTIME':
      return 'Airtime Topup';
    case 'MOBILEDATA':
      return 'Data Topup';
    case 'CABLEBILLS':
      return 'Cable TV';
    case 'INTSERVICE':
      return 'Internet';
    case 'UTILITYBILLS':
      return 'Utilities';
    default: {
      const raw = String(code ?? '').trim();
      if (!raw) return 'Bill';
      return raw
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
}

export function formatBillPayLabel(meta: Record<string, unknown>): string {
  const biller = String(meta.billerName ?? meta.itemName ?? '').trim();
  const category = formatBillCategoryLabel(String(meta.categoryCode ?? ''));
  if (
    biller &&
    category &&
    !biller.toLowerCase().includes(category.toLowerCase())
  ) {
    return `${biller} ${category}`;
  }
  return biller || category || 'Bill Topup';
}

export function billPayActivityReason(
  meta: Record<string, unknown>,
  customerId?: string | null
): string {
  const label = formatBillPayLabel(meta);
  const customer = String(customerId ?? meta.customerId ?? '').trim();
  return customer ? `${label} · ${customer}` : label;
}

export function billRefundActivityReason(meta: Record<string, unknown>): string {
  const label = formatBillPayLabel(meta);
  const action = formatBillCategoryLabel(String(meta.categoryCode ?? ''));
  return `${action} refund · ${label}`;
}

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
  accountType?: string;
  networkId?: string;
  beneficiaryCountry?: string;
  bankName?: string;
  receiveAmount?: number;
  receiveCurrency?: string;
  paymentSequenceId?: string;
  collectionSequenceId?: string;
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

function countryForWalletCurrency(currency: string): string {
  switch (String(currency).toUpperCase()) {
    case 'USD':
      return 'US';
    case 'EUR':
      return 'EU';
    case 'GBP':
      return 'GB';
    default:
      return 'NG';
  }
}

function parseP2pTagFromReason(reason?: string | null): string | null {
  const match = String(reason ?? '').match(/^p2p:@?(.+)$/i);
  return match?.[1]?.trim() || null;
}

function channelForSource(
  source: RecordWalletActivityParams['source'],
  channel?: RecordWalletActivityParams['channel']
): 'crypto' | 'bank' | 'wallet' {
  if (channel) return channel;
  if (source === 'stellar') return 'crypto';
  if (source === 'flutterwave' || source === 'grey') return 'bank';
  if (source === 'bank_out') return 'bank';
  if (source === 'p2p') return 'wallet';
  if (source === 'dayearn' || source === 'dayflow') return 'wallet';
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

  const existing = await db.oneOrNone<{ id: string; status: string | null }>(
    `SELECT id, status FROM wallet_transactions WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (existing) {
    const nextStatus = defaultStatus(direction, params.status);
    const nextReason =
      params.reason?.trim() || params.title?.trim() || undefined;
    if (
      nextReason ||
      (nextStatus && existing.status !== nextStatus)
    ) {
      await db.none(
        `UPDATE wallet_transactions
         SET status = COALESCE($2, status),
             reason = COALESCE($3, reason)
         WHERE id = $1`,
        [id, nextStatus, nextReason ?? null]
      );
      if (params.beneficiaryName?.trim()) {
        const benId = await db.oneOrNone<{ beneficiary_id: string | null }>(
          `SELECT beneficiary_id FROM wallet_transactions WHERE id = $1`,
          [id]
        );
        if (benId?.beneficiary_id) {
          await db.none(`UPDATE beneficiaries SET name = $2 WHERE id = $1`, [
            benId.beneficiary_id,
            params.beneficiaryName.trim(),
          ]);
        }
      }
    }
    return { recorded: false };
  }

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
    const beneficiaryCountry = params.beneficiaryCountry?.trim() || 'NG';
    await db.none(
      `INSERT INTO beneficiaries (id, user_id, name, country, phone, address, dob, email, id_number, id_type)
       VALUES ($1, $2, $3, $4, '', '', '', '', '', 'individual')
       ON CONFLICT (id) DO NOTHING`,
      [beneficiaryId, userId, beneficiaryName, beneficiaryCountry]
    );
  }

  let sourceId: string | null = null;
  const accountNumber = params.accountNumber?.trim();
  if (beneficiaryId && accountNumber) {
    sourceId = `src-act-${id.slice(0, 40)}`;
    await db.none(
      `INSERT INTO source (id, account_type, account_number, network_id, beneficiary_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        sourceId,
        params.accountType?.trim() || 'dayfi',
        accountNumber,
        params.networkId?.trim() || '',
        beneficiaryId,
      ]
    );
  }

  if (direction === 'credit') {
    await db.none(
      `INSERT INTO wallet_transactions (
         id, user_id, beneficiary_id, source_id, status, reason,
         receive_amount, receive_channel, receive_network,
         ledger_currency, activity_kind, external_reference, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        userId,
        beneficiaryId,
        sourceId,
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
    const receiveAmount =
      params.receiveAmount != null && Number.isFinite(params.receiveAmount)
        ? Number(params.receiveAmount)
        : null;
    const receiveCurrency = params.receiveCurrency?.trim().toUpperCase() || null;

    const paymentSequenceId = params.paymentSequenceId?.trim() || null;
    const collectionSequenceId = params.collectionSequenceId?.trim() || null;

    await db.none(
      `INSERT INTO wallet_transactions (
         id, user_id, beneficiary_id, source_id, status, reason,
         send_amount, send_channel, send_network,
         receive_amount, receive_channel, receive_network,
         ledger_currency, activity_kind, external_reference,
         payment_sequence_id, collection_sequence_id, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        id,
        userId,
        beneficiaryId,
        sourceId,
        status,
        reason,
        amount,
        channel,
        network,
        receiveAmount,
        receiveAmount != null ? 'bank' : null,
        receiveCurrency,
        currency,
        kind,
        extRef,
        paymentSequenceId,
        collectionSequenceId,
        recordedAt,
      ]
    );
  }

  return { recorded: true };
}

async function ledgerDebitWasReversed(
  userId: string,
  externalReference: string
): Promise<boolean> {
  const ref = String(externalReference || '').trim();
  if (!ref) return false;
  const row = await db.oneOrNone<{ ok: number }>(
    `SELECT 1 AS ok
     FROM ledger_movements
     WHERE user_id = $1
       AND direction = 'credit'
       AND external_reference = $2
       AND COALESCE(metadata->>'reversal', 'false') = 'true'
     LIMIT 1`,
    [userId, `${ref}-reversal`]
  );
  return Boolean(row);
}

/** Mark debits reversed in ledger as failed-payment in wallet history. */
export async function repairFailedWalletTransactionStatuses(
  userId: string
): Promise<{ repaired: number }> {
  const rows = await db.manyOrNone<{ id: string }>(
    `UPDATE wallet_transactions wt
     SET status = 'failed-payment'
     WHERE wt.user_id = $1
       AND wt.activity_kind = 'withdrawal'
       AND wt.status IN ('success-payment', 'pending-payment')
       AND EXISTS (
         SELECT 1
         FROM ledger_movements lm_d
         INNER JOIN ledger_movements lm_rev
           ON lm_rev.user_id = lm_d.user_id
          AND lm_rev.direction = 'credit'
          AND COALESCE(lm_rev.metadata->>'reversal', 'false') = 'true'
          AND (
            lm_rev.external_reference = lm_d.external_reference || '-reversal'
            OR lm_rev.metadata->>'originalReference' = lm_d.external_reference
          )
         WHERE lm_d.user_id = wt.user_id
           AND lm_d.direction = 'debit'
           AND lm_d.source IN ('yellowcard', 'bill_pay')
           AND (
             lm_d.external_reference =
               regexp_replace(COALESCE(wt.id, ''), '^wt-', '')
             OR (
               wt.send_amount IS NOT NULL
               AND ABS(lm_d.amount::numeric - wt.send_amount::numeric) < 0.02
               AND lm_d.created_at >= wt.timestamp - interval '15 minutes'
               AND lm_d.created_at <= wt.timestamp + interval '15 minutes'
             )
           )
       )
     RETURNING wt.id`,
    [userId]
  );
  return { repaired: rows?.length ?? 0 };
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
    const isBillPay = row.source === 'bill_pay';
    const isYellowCardDebit =
      row.source === 'yellowcard' && row.direction === 'debit';
    const collectionId = row.external_reference?.trim() ?? '';
    let debitFailed = false;

    if (isYellowCardDebit && collectionId) {
      debitFailed = await ledgerDebitWasReversed(row.user_id, collectionId);
      const wtId = buildWalletActivityTxId(collectionId);
      const existing = await db.oneOrNone<{ id: string; status: string }>(
        `SELECT id, status FROM wallet_transactions
         WHERE user_id = $1 AND (id = $2 OR id = $3)
         LIMIT 1`,
        [row.user_id, collectionId, wtId]
      );
      if (existing) {
        if (debitFailed && existing.status === 'success-payment') {
          await db.none(
            `UPDATE wallet_transactions SET status = 'failed-payment' WHERE id = $1`,
            [existing.id]
          );
        }
        continue;
      }
    }

    const isBillPayDebit = isBillPay && row.direction === 'debit';
    if (isBillPayDebit && row.external_reference) {
      debitFailed =
        debitFailed ||
        (await ledgerDebitWasReversed(row.user_id, row.external_reference));
    }

    const assetCode = String(meta.assetCode ?? row.currency).toUpperCase();
    const isSwap = row.source === 'swap';
    const activityTitle =
      typeof meta.activityTitle === 'string' ? meta.activityTitle.trim() : '';
    const isP2p = row.source === 'p2p';
    const isBillReversal =
      row.source === 'manual' &&
      meta.reversal === true &&
      (meta.categoryCode || meta.billerName || meta.itemName);
    const txId =
      isSwap && row.external_reference
        ? buildWalletActivityTxId(
            row.direction === 'credit'
              ? `swap-credit-${row.external_reference}`
              : `swap-debit-${row.external_reference}`
          )
        : isP2p && row.external_reference
          ? buildWalletActivityTxId(
              row.direction === 'credit'
                ? `p2p-credit-${row.external_reference}`
                : `p2p-debit-${row.external_reference}`
            )
          : buildWalletActivityTxId(row.external_reference, row.id);

    let p2pTagFromLegacy: string | null = null;
    if (isP2p && row.direction === 'debit' && row.external_reference) {
      p2pTagFromLegacy = parseP2pTagFromReason(
        (
          await db.oneOrNone<{ reason: string }>(
            `SELECT reason FROM wallet_transactions WHERE id = $1 LIMIT 1`,
            [row.external_reference]
          )
        )?.reason
      );
      if (!p2pTagFromLegacy) {
        const fromTransfer = await db.oneOrNone<{ dayfi_id: string | null }>(
          `SELECT w.dayfi_id
           FROM p2p_transfers pt
           JOIN wallets w ON w.user_id = pt.recipient_user_id AND w.currency = 'USD'
           WHERE pt.reference = $1
           LIMIT 1`,
          [row.external_reference]
        );
        p2pTagFromLegacy =
          fromTransfer?.dayfi_id?.replace(/^@/, '').trim() || null;
      }
    }

    const p2pSenderLabel =
      isP2p && row.direction === 'credit' && meta.senderUserId
        ? await db.oneOrNone<{ dayfi_id: string | null; first_name: string | null }>(
            `SELECT w.dayfi_id, u.first_name
             FROM users u
             LEFT JOIN wallets w ON w.user_id = u.user_id AND w.currency = 'USD'
             WHERE u.user_id = $1
             LIMIT 1`,
            [String(meta.senderUserId)]
          )
        : null;

    const billLabel = isBillPay || isBillReversal ? formatBillPayLabel(meta) : '';
    const billAction =
      isBillPay || isBillReversal
        ? formatBillCategoryLabel(String(meta.categoryCode ?? ''))
        : '';
    const metaSendAmount = Number(meta.sendAmount);
    const displayDebitAmount =
      isYellowCardDebit &&
      Number.isFinite(metaSendAmount) &&
      metaSendAmount > 0
        ? metaSendAmount
        : Number(row.amount);
    const isGreyCredit = row.source === 'grey' && row.direction === 'credit';
    const ycAccountName = String(meta.accountName ?? '').trim();
    const ycBankName = String(meta.bankName ?? '').trim();
    const ycReceiveAmount = Number(meta.receiveAmount);
    const ycReceiveCurrency = String(meta.receiveCurrency ?? 'NGN')
      .trim()
      .toUpperCase();
    const ycActivityTitle =
      activityTitle ||
      (ycAccountName && ycBankName
        ? `Send to ${ycAccountName} · ${ycBankName}`
        : ycAccountName
          ? `Send to ${ycAccountName}`
          : '');

    const result = await recordWalletActivity({
      userId: row.user_id,
      id: txId,
      direction: row.direction === 'credit' ? 'credit' : 'debit',
      amount:
        row.direction === 'credit' ? Number(row.amount) : displayDebitAmount,
      currency: row.currency,
      source: row.source as LedgerSource,
      title: isSwap
        ? activityTitle || `Convert ${meta.fromCurrency ?? row.currency}`
        : isBillPay
          ? billLabel
          : isBillReversal
            ? `${billAction} refund`
            : isYellowCardDebit && ycActivityTitle
              ? ycActivityTitle
            : isGreyCredit
              ? `${row.currency} bank deposit`
              : row.direction === 'credit'
                ? `${assetCode} deposit`
                : `${row.currency} withdrawal`,
      externalReference: row.external_reference ?? undefined,
      channel:
        row.source === 'stellar'
          ? 'crypto'
          : row.source === 'flutterwave' || isGreyCredit || isYellowCardDebit
            ? 'bank'
            : isBillPay || isBillReversal
              ? 'wallet'
              : 'wallet',
      network: row.source === 'stellar' ? 'stellar' : null,
      status: isBillPay
        ? debitFailed
          ? 'failed-payment'
          : 'success-payment'
        : isBillReversal
          ? 'success-collection'
          : isYellowCardDebit && debitFailed
            ? 'failed-payment'
            : undefined,
      reason: isSwap
        ? activityTitle ||
          `Convert ${meta.fromCurrency ?? ''} → ${meta.toCurrency ?? row.currency}`
        : isBillPay
          ? billPayActivityReason(meta, String(meta.customerId ?? ''))
          : isBillReversal
            ? billRefundActivityReason(meta)
            : isP2p && row.direction === 'debit' && p2pTagFromLegacy
              ? `p2p:${p2pTagFromLegacy}`
              : isYellowCardDebit && ycActivityTitle
                ? ycActivityTitle
              : row.direction === 'credit'
                ? row.source === 'flutterwave'
                  ? NGN_BANK_DEPOSIT_REASON
                  : isGreyCredit
                    ? USD_BANK_DEPOSIT_REASON
                    : `${assetCode} deposit via ${row.source}`
                : `${row.currency} sent via ${row.source}`,
      beneficiaryName: isSwap
        ? 'Currency conversion'
        : isBillPay
          ? billLabel
          : isBillReversal
            ? `${billAction} refund`
            : isYellowCardDebit && ycAccountName
              ? ycAccountName
            : isP2p && row.direction === 'debit' && p2pTagFromLegacy
              ? `@${p2pTagFromLegacy}`
              : isP2p && row.direction === 'credit'
                ? p2pSenderLabel?.dayfi_id
                  ? `@${String(p2pSenderLabel.dayfi_id).replace(/^@/, '')}`
                  : p2pSenderLabel?.first_name?.trim() || 'Dayfi user'
                : row.direction === 'credit'
                  ? 'Wallet Top Up'
                  : 'Recipient',
      accountNumber:
        isBillPay || isBillReversal
          ? String(meta.customerId ?? '').trim() || undefined
          : isYellowCardDebit
            ? String(meta.accountNumber ?? '').trim() || undefined
          : isP2p && row.direction === 'debit' && p2pTagFromLegacy
            ? p2pTagFromLegacy
            : isP2p &&
                row.direction === 'credit' &&
                p2pSenderLabel?.dayfi_id
              ? String(p2pSenderLabel.dayfi_id).replace(/^@/, '')
              : undefined,
      accountType: isBillPay || isBillReversal
        ? 'bill'
        : isYellowCardDebit
          ? String(meta.accountType ?? 'bank').trim() || 'bank'
        : isP2p
          ? 'dayfi'
          : row.source === 'dayearn'
            ? 'dayearn'
            : row.source === 'dayflow' && row.direction === 'credit'
              ? 'dayflow'
              : undefined,
      networkId:
        isBillPay || isBillReversal
          ? String(meta.billerCode ?? '').trim() || undefined
          : isYellowCardDebit
            ? String(meta.networkId ?? '').trim() || undefined
            : undefined,
      bankName: isYellowCardDebit ? ycBankName || undefined : undefined,
      receiveAmount:
        isYellowCardDebit && Number.isFinite(ycReceiveAmount) && ycReceiveAmount > 0
          ? ycReceiveAmount
          : undefined,
      receiveCurrency: isYellowCardDebit ? ycReceiveCurrency : undefined,
      beneficiaryCountry: isP2p
        ? countryForWalletCurrency(row.currency)
        : isBillPay || isBillReversal
          ? 'NG'
          : isYellowCardDebit
            ? String(meta.payoutCountry ?? 'NG').trim() || 'NG'
          : isGreyCredit
            ? countryForWalletCurrency(row.currency)
            : undefined,
      timestamp: row.created_at,
    });
    if (result.recorded) inserted += 1;
  }

  return { inserted };
}

async function resolveP2pRecipientTag(
  userId: string,
  row: {
    id: string;
    external_reference: string | null;
    send_amount: string | null;
    timestamp: Date;
  }
): Promise<string | null> {
  const refs: string[] = [];
  if (row.external_reference?.trim()) refs.push(row.external_reference.trim());
  const idMatch = row.id.match(/^wt-p2p-debit-(.+)$/i);
  if (idMatch?.[1]) refs.push(idMatch[1]);

  for (const ref of refs) {
    const fromP2p = await db.oneOrNone<{ dayfi_id: string | null }>(
      `SELECT w.dayfi_id
       FROM p2p_transfers pt
       JOIN wallets w ON w.user_id = pt.recipient_user_id AND w.currency = 'USD'
       WHERE pt.reference = $1 AND pt.sender_user_id = $2
       LIMIT 1`,
      [ref, userId]
    );
    const tag = fromP2p?.dayfi_id?.replace(/^@/, '').trim();
    if (tag) return tag;
  }

  const amount = Number(row.send_amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const fromAmount = await db.oneOrNone<{ dayfi_id: string | null }>(
    `SELECT w.dayfi_id
     FROM p2p_transfers pt
     JOIN wallets w ON w.user_id = pt.recipient_user_id AND w.currency = 'USD'
     WHERE pt.sender_user_id = $1
       AND pt.amount_usd = $2
     ORDER BY ABS(EXTRACT(EPOCH FROM (pt.created_at - $3::timestamp))) ASC
     LIMIT 1`,
    [userId, amount, row.timestamp]
  );
  return fromAmount?.dayfi_id?.replace(/^@/, '').trim() || null;
}

/** Fix legacy P2P rows that still show generic "Recipient" / missing username metadata. */
export async function repairP2pWalletTransactions(
  userId: string
): Promise<{ repaired: number }> {
  const rows = await db.manyOrNone<{
    id: string;
    external_reference: string | null;
    send_amount: string | null;
    ledger_currency: string | null;
    reason: string | null;
    beneficiary_id: string | null;
    source_id: string | null;
    beneficiary_name: string | null;
    timestamp: Date;
  }>(
    `SELECT wt.id, wt.external_reference, wt.send_amount, wt.ledger_currency,
            wt.reason, wt.beneficiary_id, wt.source_id, b.name AS beneficiary_name,
            wt.timestamp
     FROM wallet_transactions wt
     LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
     WHERE wt.user_id = $1
       AND wt.status::text ILIKE '%payment%'
       AND (
         LOWER(COALESCE(b.name, '')) IN ('recipient', '')
         OR wt.reason ILIKE '%via p2p%'
         OR wt.id ILIKE '%p2p%'
         OR wt.source_id IS NULL
       )
       AND (
         COALESCE(wt.reason, '') NOT LIKE 'p2p:%'
         OR LOWER(COALESCE(b.name, '')) IN ('recipient', '')
         OR wt.source_id IS NULL
       )`,
    [userId]
  );

  let repaired = 0;
  for (const row of rows ?? []) {
    const tag = await resolveP2pRecipientTag(userId, row);
    if (!tag) continue;

    const recipient = await db.oneOrNone<{
      first_name: string | null;
      last_name: string | null;
      dayfi_id: string | null;
    }>(
      `SELECT u.first_name, u.last_name, w.dayfi_id
       FROM wallets w
       JOIN users u ON u.user_id = w.user_id
       WHERE LOWER(TRIM(BOTH '@' FROM COALESCE(w.dayfi_id, ''))) = $1
         AND w.currency = COALESCE($2, 'USD')
       LIMIT 1`,
      [tag.toLowerCase(), row.ledger_currency ?? 'USD']
    );

    const resolvedTag = recipient?.dayfi_id?.replace(/^@/, '').trim() || tag;
    const legalName = [recipient?.first_name, recipient?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    const beneficiaryLabel = legalName
      ? `@${resolvedTag} · ${legalName}`
      : `@${resolvedTag}`;
    const currency = String(row.ledger_currency ?? 'USD').toUpperCase();

    let beneficiaryId = row.beneficiary_id;
    if (beneficiaryId) {
      await db.none(
        `UPDATE beneficiaries
         SET name = $2, country = $3
         WHERE id = $1`,
        [beneficiaryId, beneficiaryLabel, countryForWalletCurrency(currency)]
      );
    } else {
      beneficiaryId = `ben-repair-${row.id.slice(0, 32)}`;
      await db.none(
        `INSERT INTO beneficiaries (id, user_id, name, country, phone, address, dob, email, id_number, id_type)
         VALUES ($1, $2, $3, $4, '', '', '', '', '', 'individual')
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, country = EXCLUDED.country`,
        [
          beneficiaryId,
          userId,
          beneficiaryLabel,
          countryForWalletCurrency(currency),
        ]
      );
    }

    let sourceId = row.source_id;
    if (sourceId) {
      await db.none(
        `UPDATE source
         SET account_type = 'dayfi', account_number = $2, network_id = ''
         WHERE id = $1`,
        [sourceId, resolvedTag]
      );
    } else if (beneficiaryId) {
      sourceId = `src-repair-${row.id.slice(0, 32)}`;
      await db.none(
        `INSERT INTO source (id, account_type, account_number, network_id, beneficiary_id)
         VALUES ($1, 'dayfi', $2, '', $3)
         ON CONFLICT (id) DO UPDATE
           SET account_type = EXCLUDED.account_type,
               account_number = EXCLUDED.account_number`,
        [sourceId, resolvedTag, beneficiaryId]
      );
    }

    await db.none(
      `UPDATE wallet_transactions
       SET reason = $2,
           beneficiary_id = COALESCE(beneficiary_id, $3),
           source_id = COALESCE(source_id, $4),
           send_channel = 'wallet'
       WHERE id = $1`,
      [row.id, `p2p:${resolvedTag}`, beneficiaryId, sourceId]
    );
    repaired += 1;
  }

  return { repaired };
}

function billRefFromWalletRow(row: {
  id: string;
  external_reference: string | null;
}): string | null {
  const ref = row.external_reference?.trim();
  if (ref?.includes('dayfi-bill')) {
    return ref.replace(/-reversal$/i, '');
  }
  const idMatch = row.id.match(/dayfi-bill-[a-f0-9-]+/i);
  return idMatch?.[0]?.replace(/-reversal$/i, '') ?? null;
}

async function ledgerBillMetaForWalletRow(
  userId: string,
  row: { id: string; external_reference: string | null; status: string | null }
): Promise<Record<string, unknown> | null> {
  const billRef = billRefFromWalletRow(row);
  if (!billRef) return null;

  const isReversal =
    row.external_reference?.toLowerCase().includes('-reversal') ||
    row.id.toLowerCase().includes('-reversal');

  const movement = await db.oneOrNone<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata
     FROM ledger_movements
     WHERE user_id = $1
       AND (
         external_reference = $2
         OR external_reference = $3
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      userId,
      isReversal ? `${billRef}-reversal` : billRef,
      billRef,
    ]
  );
  return movement?.metadata ?? null;
}

/** Fix legacy bill rows that still show generic "Bill payment" / "sent via bill_pay". */
export async function repairBillWalletTransactions(
  userId: string
): Promise<{ repaired: number }> {
  const rows = await db.manyOrNone<{
    id: string;
    external_reference: string | null;
    reason: string | null;
    beneficiary_id: string | null;
    source_id: string | null;
    beneficiary_name: string | null;
    status: string | null;
  }>(
    `SELECT wt.id, wt.external_reference, wt.reason, wt.beneficiary_id,
            wt.source_id, b.name AS beneficiary_name, wt.status
     FROM wallet_transactions wt
     LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
     WHERE wt.user_id = $1
       AND (
         wt.id ILIKE '%dayfi-bill%'
         OR wt.external_reference ILIKE '%dayfi-bill%'
       )
       AND (
         LOWER(COALESCE(b.name, '')) IN ('recipient', 'bill payment', 'bill topup', '')
         OR LOWER(COALESCE(b.name, '')) LIKE '%bill payment%'
         OR LOWER(COALESCE(b.name, '')) LIKE '%bill topup%'
         OR wt.reason ILIKE '%sent via bill_pay%'
         OR wt.reason ILIKE '%usd sent via%'
         OR wt.reason ILIKE '%wallet credit%'
         OR wt.reason ILIKE '%bill payment%'
         OR wt.reason ILIKE '%bill refund%'
       )`,
    [userId]
  );

  let repaired = 0;
  for (const row of rows ?? []) {
    const meta = await ledgerBillMetaForWalletRow(userId, row);
    if (!meta || !(meta.categoryCode || meta.billerName || meta.itemName)) {
      continue;
    }

    const isReversal =
      row.external_reference?.toLowerCase().includes('-reversal') ||
      row.id.toLowerCase().includes('-reversal') ||
      meta.reversal === true;

    const billLabel = formatBillPayLabel(meta);
    const actionLabel = formatBillCategoryLabel(String(meta.categoryCode ?? ''));
    const reason = isReversal
      ? billRefundActivityReason(meta)
      : billPayActivityReason(meta, String(meta.customerId ?? ''));
    const beneficiaryLabel = isReversal
      ? `${actionLabel} refund`
      : billLabel;
    const customerId = String(meta.customerId ?? '').trim();

    let beneficiaryId = row.beneficiary_id;
    if (beneficiaryId) {
      await db.none(
        `UPDATE beneficiaries SET name = $2 WHERE id = $1`,
        [beneficiaryId, beneficiaryLabel]
      );
    } else {
      beneficiaryId = `ben-bill-${row.id.slice(0, 32)}`;
      await db.none(
        `INSERT INTO beneficiaries (id, user_id, name, country, phone, address, dob, email, id_number, id_type)
         VALUES ($1, $2, $3, 'NG', '', '', '', '', '', 'individual')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [beneficiaryId, userId, beneficiaryLabel]
      );
    }

    let sourceId = row.source_id;
    if (customerId) {
      if (sourceId) {
        await db.none(
          `UPDATE source SET account_type = 'bill', account_number = $2 WHERE id = $1`,
          [sourceId, customerId]
        );
      } else if (beneficiaryId) {
        sourceId = `src-bill-${row.id.slice(0, 32)}`;
        await db.none(
          `INSERT INTO source (id, account_type, account_number, network_id, beneficiary_id)
           VALUES ($1, 'bill', $2, '', $3)
           ON CONFLICT (id) DO UPDATE
             SET account_type = EXCLUDED.account_type,
                 account_number = EXCLUDED.account_number`,
          [sourceId, customerId, beneficiaryId]
        );
      }
    }

    await db.none(
      `UPDATE wallet_transactions
       SET reason = $2,
           beneficiary_id = COALESCE(beneficiary_id, $3),
           source_id = COALESCE(source_id, $4),
           send_channel = COALESCE(send_channel, 'wallet'),
           receive_channel = COALESCE(receive_channel, 'wallet')
       WHERE id = $1`,
      [row.id, reason, beneficiaryId, sourceId]
    );
    repaired += 1;
  }

  return { repaired };
}

/** Fix legacy Yellow Card send rows that still show generic "Recipient" / missing bank name. */
export async function repairYellowCardWalletTransactions(
  userId: string
): Promise<{ repaired: number }> {
  await db.none(
    `UPDATE wallet_transactions wt
     SET send_amount = (lm.metadata->>'sendAmount')::numeric
     FROM ledger_movements lm
     WHERE wt.user_id = $1
       AND lm.user_id = wt.user_id
       AND lm.direction = 'debit'
       AND lm.source = 'yellowcard'
       AND (lm.metadata->>'sendAmount') ~ '^[0-9]+(\\.[0-9]+)?$'
       AND (lm.metadata->>'sendAmount')::numeric > 0
       AND (
         lm.external_reference = regexp_replace(wt.id, '^wt-', '')
         OR (
           wt.send_amount IS NOT NULL
           AND ABS(lm.amount::numeric - wt.send_amount::numeric) < 0.02
           AND lm.created_at >= wt.timestamp - interval '15 minutes'
           AND lm.created_at <= wt.timestamp + interval '15 minutes'
         )
         OR (
           wt.send_amount IS NOT NULL
           AND (lm.metadata->>'feeUsd') ~ '^[0-9]+(\\.[0-9]+)?$'
           AND ABS(
             lm.amount::numeric
             - wt.send_amount::numeric
             - (lm.metadata->>'feeUsd')::numeric
           ) < 0.02
           AND lm.created_at >= wt.timestamp - interval '15 minutes'
           AND lm.created_at <= wt.timestamp + interval '15 minutes'
         )
       )
       AND wt.send_amount IS DISTINCT FROM (lm.metadata->>'sendAmount')::numeric`,
    [userId]
  );

  await db.none(
    `UPDATE wallet_transactions wt
     SET reason = COALESCE(
           NULLIF(TRIM(lm.metadata->>'activityTitle'), ''),
           CASE
             WHEN TRIM(lm.metadata->>'bankName') <> ''
             THEN 'Send to ' || TRIM(lm.metadata->>'accountName')
                  || ' · ' || TRIM(lm.metadata->>'bankName')
             ELSE 'Send to ' || TRIM(lm.metadata->>'accountName')
           END
         )
     FROM ledger_movements lm
     WHERE wt.user_id = $1
       AND lm.user_id = wt.user_id
       AND lm.direction = 'debit'
       AND lm.source = 'yellowcard'
       AND TRIM(lm.metadata->>'accountName') <> ''
       AND (
         lm.external_reference = regexp_replace(wt.id, '^wt-', '')
         OR (
           wt.send_amount IS NOT NULL
           AND ABS(lm.amount::numeric - wt.send_amount::numeric) < 0.02
           AND lm.created_at >= wt.timestamp - interval '15 minutes'
           AND lm.created_at <= wt.timestamp + interval '15 minutes'
         )
       )
       AND COALESCE(wt.reason, '') NOT ILIKE 'send to %'`,
    [userId]
  );

  const rows = await db.manyOrNone<{
    id: string;
    reason: string | null;
    beneficiary_id: string | null;
    source_id: string | null;
    send_channel: string | null;
    receive_amount: string | null;
    receive_network: string | null;
    beneficiary_name: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT wt.id, wt.reason, wt.beneficiary_id, wt.source_id, wt.send_channel,
            wt.receive_amount, wt.receive_network, b.name AS beneficiary_name,
            lm.metadata
     FROM wallet_transactions wt
     LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
     JOIN ledger_movements lm
       ON lm.user_id = wt.user_id
      AND lm.direction = 'debit'
      AND lm.source = 'yellowcard'
      AND (
        lm.external_reference = regexp_replace(wt.id, '^wt-', '')
        OR (
          wt.send_amount IS NOT NULL
          AND ABS(lm.amount::numeric - wt.send_amount::numeric) < 0.02
          AND lm.created_at >= wt.timestamp - interval '15 minutes'
          AND lm.created_at <= wt.timestamp + interval '15 minutes'
        )
      )
     WHERE wt.user_id = $1
       AND wt.activity_kind = 'withdrawal'
       AND (
         LOWER(COALESCE(b.name, '')) IN ('recipient', '')
         OR COALESCE(wt.reason, '') NOT ILIKE 'send to %'
         OR COALESCE(wt.reason, '') ILIKE '% sent via yellowcard%'
         OR wt.receive_amount IS NULL
         OR wt.send_channel IS DISTINCT FROM 'bank'
       )`,
    [userId]
  );

  let repaired = 0;
  for (const row of rows ?? []) {
    const meta = row.metadata ?? {};
    const accountName = String(meta.accountName ?? '').trim();
    const bankName = String(meta.bankName ?? '').trim();
    if (!accountName) continue;

    const activityTitle =
      typeof meta.activityTitle === 'string' && meta.activityTitle.trim()
        ? meta.activityTitle.trim()
        : bankName
          ? `Send to ${accountName} · ${bankName}`
          : `Send to ${accountName}`;

    const receiveAmount = Number(meta.receiveAmount);
    const receiveCurrency = String(meta.receiveCurrency ?? 'NGN')
      .trim()
      .toUpperCase();
    const payoutCountry = String(meta.payoutCountry ?? 'NG').trim() || 'NG';
    const accountNumber = String(meta.accountNumber ?? '').trim();
    const networkId = String(meta.networkId ?? '').trim();
    const accountType = String(meta.accountType ?? 'bank').trim() || 'bank';

    let beneficiaryId = row.beneficiary_id;
    if (beneficiaryId) {
      await db.none(`UPDATE beneficiaries SET name = $2, country = $3 WHERE id = $1`, [
        beneficiaryId,
        accountName,
        payoutCountry,
      ]);
    } else {
      beneficiaryId = `ben-yc-${row.id.slice(0, 32)}`;
      await db.none(
        `INSERT INTO beneficiaries (id, user_id, name, country, phone, address, dob, email, id_number, id_type)
         VALUES ($1, $2, $3, $4, '', '', '', '', '', 'individual')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country`,
        [beneficiaryId, userId, accountName, payoutCountry]
      );
    }

    let sourceId = row.source_id;
    if (accountNumber) {
      if (sourceId) {
        await db.none(
          `UPDATE source
           SET account_type = $2, account_number = $3, network_id = $4
           WHERE id = $1`,
          [sourceId, accountType, accountNumber, networkId]
        );
      } else if (beneficiaryId) {
        sourceId = `src-yc-${row.id.slice(0, 32)}`;
        await db.none(
          `INSERT INTO source (id, account_type, account_number, network_id, beneficiary_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE
             SET account_type = EXCLUDED.account_type,
                 account_number = EXCLUDED.account_number,
                 network_id = EXCLUDED.network_id`,
          [sourceId, accountType, accountNumber, networkId, beneficiaryId]
        );
      }
    }

    await db.none(
      `UPDATE wallet_transactions
       SET reason = $2,
           beneficiary_id = COALESCE(beneficiary_id, $3),
           source_id = COALESCE(source_id, $4),
           send_channel = 'bank',
           receive_channel = 'bank',
           receive_amount = COALESCE($5, receive_amount),
           receive_network = COALESCE($6, receive_network)
       WHERE id = $1`,
      [
        row.id,
        activityTitle,
        beneficiaryId,
        sourceId,
        Number.isFinite(receiveAmount) && receiveAmount > 0 ? receiveAmount : null,
        receiveCurrency,
      ]
    );
    repaired += 1;
  }

  await db.none(
    `UPDATE wallet_transactions
     SET payment_sequence_id = external_reference
     WHERE user_id = $1
       AND payment_sequence_id IS NULL
       AND external_reference IS NOT NULL
       AND activity_kind = 'withdrawal'`,
    [userId]
  );

  try {
    await syncYellowCardPaymentStatusesForUser(userId);
  } catch (_) {
    /* optional live status sync */
  }

  return { repaired };
}

/** Align wallet row status with Yellow Card provider (Pending_provider → pending-payment). */
export async function syncYellowCardPaymentStatusesForUser(
  userId: string
): Promise<{ synced: number }> {
  const { default: YellowCardService } = await import('./yellowCardService');
  const { resolveYellowCardPaymentStatus } = await import('./yellowCardStatus');
  const yc = new YellowCardService();
  if (!yc.isConfigured()) return { synced: 0 };

  const rows = await db.manyOrNone<{
    id: string;
    payment_sequence_id: string | null;
    external_reference: string | null;
    status: string;
  }>(
    `SELECT id, payment_sequence_id, external_reference, status
     FROM wallet_transactions
     WHERE user_id = $1
       AND activity_kind = 'withdrawal'
       AND send_channel = 'bank'
       AND COALESCE(payment_sequence_id, external_reference) IS NOT NULL
       AND timestamp > NOW() - interval '30 days'`,
    [userId]
  );

  let synced = 0;
  for (const row of rows ?? []) {
    const seq = row.payment_sequence_id ?? row.external_reference;
    if (!seq) continue;
    try {
      const payment = await yc.fetchPaymentBySequenceId(seq);
      const mapped = resolveYellowCardPaymentStatus(payment);
      if (mapped !== row.status) {
        await db.none(
          `UPDATE wallet_transactions SET status = $2 WHERE id = $1`,
          [row.id, mapped]
        );
        synced += 1;
        console.info(
          `[yellowcard] status sync ${seq}: ${row.status} → ${mapped}`
        );
      }
    } catch (err) {
      console.warn(
        `[yellowcard] status sync skipped for ${seq}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return { synced };
}
