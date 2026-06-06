import { db } from '../../config/database';
import PaymentService from './services';
import { verifyFlutterwaveTransactionById } from './flutterwaveService';
import {
  buildWalletActivityTxId,
  recordWalletActivity,
  NGN_BANK_DEPOSIT_REASON,
} from './walletActivityService';
import {
  notifyNgnBankDeposit,
  safeNotify,
} from '../notifications/notificationService';

export { NGN_BANK_DEPOSIT_REASON };

export type FlutterwaveDepositPayload = {
  event: string;
  amount: number;
  currency: string;
  reference: string;
  transactionId: string | null;
  email: string;
  accountNumber: string;
  status: string;
  paymentType: string;
};

const paymentService = new PaymentService();

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

/** Normalize Flutterwave charge.completed / bank transfer webhook bodies. */
export function parseFlutterwaveDepositWebhook(
  body: Record<string, unknown>
): FlutterwaveDepositPayload | null {
  const event = String(body.event ?? '').trim();
  const data = asRecord(body.data) ?? body;
  const customer = asRecord(data.customer);
  const meta = asRecord(body.meta_data) ?? asRecord(data.meta) ?? asRecord(data.meta_data);

  const status = String(data.status ?? '').trim().toLowerCase();
  const paymentType = String(data.payment_type ?? data.paymentType ?? '').trim().toLowerCase();

  if (event && event !== 'charge.completed') {
    return null;
  }
  if (status && status !== 'successful') {
    return null;
  }

  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const currency = String(data.currency ?? 'NGN').trim().toUpperCase();
  const reference = pickString(
    data.flw_ref,
    data.id,
    data.tx_ref,
    body.flw_ref,
    body.tx_ref
  );
  if (!reference) return null;

  const email = pickString(
    customer?.email,
    data.email,
    body.email
  ).toLowerCase();

  const accountNumber = pickString(
    data.account_number,
    data.accountNumber,
    meta?.account_number,
    meta?.originatoraccountnumber
  ).replace(/\s/g, '');

  return {
    event: event || 'charge.completed',
    amount,
    currency,
    reference,
    transactionId: pickString(data.id) || null,
    email,
    accountNumber,
    status: status || 'successful',
    paymentType: paymentType || 'bank_transfer',
  };
}

/** Find the Dayfi user who owns this NGN virtual account deposit. */
export async function resolveUserIdForFlutterwaveDeposit(params: {
  email?: string;
  accountNumber?: string;
}): Promise<string | null> {
  const email = String(params.email ?? '').trim().toLowerCase();
  const accountNumber = String(params.accountNumber ?? '').trim();

  if (accountNumber) {
    const byAccount = await db.oneOrNone<{ user_id: string }>(
      `SELECT user_id FROM wallets
       WHERE currency = 'NGN' AND account_number = $1
       LIMIT 1`,
      [accountNumber]
    );
    if (byAccount?.user_id) return byAccount.user_id;
  }

  if (email) {
    const byEmail = await db.oneOrNone<{ user_id: string }>(
      `SELECT w.user_id FROM wallets w
       JOIN users u ON u.user_id = w.user_id
       WHERE w.currency = 'NGN' AND LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email]
    );
    if (byEmail?.user_id) return byEmail.user_id;
  }

  return null;
}

/** Enrich webhook payload from Flutterwave verify API when user lookup fields are missing. */
export async function enrichFlutterwaveDepositFromApi(
  payload: FlutterwaveDepositPayload
): Promise<FlutterwaveDepositPayload> {
  if (!payload.transactionId) return payload;
  if (payload.email && payload.accountNumber) return payload;

  try {
    const tx = await verifyFlutterwaveTransactionById(payload.transactionId);
    const customer = asRecord(tx.customer);
    return {
      ...payload,
      email:
        payload.email ||
        pickString(customer?.email, tx.email).toLowerCase(),
      accountNumber:
        payload.accountNumber ||
        pickString(tx.account_number, tx.accountNumber),
      amount: Number(tx.amount ?? payload.amount) || payload.amount,
      currency: String(tx.currency ?? payload.currency).toUpperCase(),
      reference: pickString(tx.flw_ref, tx.id, payload.reference),
    };
  } catch (err: unknown) {
    console.warn(
      `[enrichFlutterwaveDepositFromApi] skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return payload;
  }
}

/** Idempotent NGN deposit credit (USD ledger + activity). */
export async function processFlutterwaveDeposit(
  payload: FlutterwaveDepositPayload
): Promise<{ userId: string; duplicate: boolean; usdAmount: number }> {
  const currency = String(payload.currency || 'NGN').toUpperCase();
  if (currency !== 'NGN') {
    throw new Error(`Unsupported Flutterwave deposit currency: ${currency}`);
  }

  let enriched = payload;
  if (!payload.email && !payload.accountNumber && payload.transactionId) {
    enriched = await enrichFlutterwaveDepositFromApi(payload);
  }

  let userId = await resolveUserIdForFlutterwaveDeposit({
    email: enriched.email,
    accountNumber: enriched.accountNumber,
  });

  if (!userId && enriched.transactionId) {
    const fromApi = await enrichFlutterwaveDepositFromApi(enriched);
    userId = await resolveUserIdForFlutterwaveDeposit({
      email: fromApi.email,
      accountNumber: fromApi.accountNumber,
    });
    enriched = fromApi;
  }

  if (!userId) {
    throw new Error(
      'User not found for deposit (check NGN virtual account email / account number match)'
    );
  }

  const result = await paymentService.creditWalletInflow(
    userId,
    enriched.amount,
    'NGN',
    'NGN',
    'flutterwave',
    enriched.reference
  );

  await upsertNgnBankDepositActivity({
    userId,
    reference: enriched.reference,
    ngnAmount: enriched.amount,
    usdAmount: result.usdAmount,
  });

  if (!result.duplicate) {
    await safeNotify(
      () =>
        notifyNgnBankDeposit({
          userId,
          ngnAmount: enriched.amount,
          usdCredited: result.usdAmount,
          reference: enriched.reference,
        }),
      'ngn_deposit'
    );
  }

  return {
    userId,
    duplicate: Boolean(result.duplicate),
    usdAmount: result.usdAmount,
  };
}

/** Ensure wallet history shows NGN received (not USD/flutterwave labels). */
async function upsertNgnBankDepositActivity(params: {
  userId: string;
  reference: string;
  ngnAmount: number;
  usdAmount?: number;
}): Promise<void> {
  const id =
    buildWalletActivityTxId(params.reference) ||
    buildWalletActivityTxId(`flutterwave-${params.reference}`);
  if (!id) return;

  const usdCredited =
    params.usdAmount != null && Number.isFinite(params.usdAmount)
      ? Number(params.usdAmount)
      : null;

  const existing = await db.oneOrNone<{ id: string }>(
    `SELECT id FROM wallet_transactions WHERE id = $1 LIMIT 1`,
    [id]
  );

  if (existing) {
    await db.none(
      `UPDATE wallet_transactions
       SET reason = $2,
           receive_amount = $3,
           send_amount = COALESCE($4, send_amount),
           ledger_currency = 'NGN',
           receive_channel = 'bank',
           activity_kind = 'deposit',
           status = 'success-collection'
       WHERE id = $1`,
      [id, NGN_BANK_DEPOSIT_REASON, params.ngnAmount, usdCredited]
    );
    return;
  }

  await recordWalletActivity({
    userId: params.userId,
    id,
    direction: 'credit',
    amount: params.ngnAmount,
    currency: 'NGN',
    source: 'flutterwave',
    title: 'NGN bank deposit',
    reason: NGN_BANK_DEPOSIT_REASON,
    externalReference: params.reference,
    channel: 'bank',
    beneficiaryName: 'Wallet Top Up',
  });

  if (usdCredited != null && usdCredited > 0) {
    await db.none(
      `UPDATE wallet_transactions SET send_amount = $2 WHERE id = $1`,
      [id, usdCredited]
    );
  }
}

/** Fix legacy rows that say "via flutterwave" or store tiny USD amounts. */
export async function repairFlutterwaveDepositActivities(
  userId?: string
): Promise<{ repaired: number }> {
  const rows = await db.manyOrNone<{
    id: string;
    external_reference: string | null;
    receive_amount: string | null;
    metadata: Record<string, unknown> | null;
    lm_amount: string;
  }>(
    `SELECT wt.id, wt.external_reference, wt.receive_amount::text, lm.metadata,
            lm.amount::text AS lm_amount
     FROM wallet_transactions wt
     JOIN ledger_movements lm
       ON lm.external_reference = wt.external_reference
      AND lm.source = 'flutterwave'
      AND lm.direction = 'credit'
     WHERE ($1::varchar IS NULL OR wt.user_id = $1)
       AND wt.receive_channel = 'bank'
       AND wt.activity_kind = 'deposit'
       AND wt.ledger_currency = 'NGN'
       AND (
         wt.reason ILIKE '%flutterwave%'
         OR wt.send_amount IS NULL
         OR wt.send_amount <= 0
         OR wt.reason = $2
       )`,
    [userId ?? null, NGN_BANK_DEPOSIT_REASON]
  );

  let repaired = 0;
  for (const row of rows ?? []) {
    const meta = row.metadata ?? {};
    const original = Number(meta.originalAmount ?? meta.original_amount ?? 0);
    const ngnAmount =
      original > 0 ? original : Number(row.receive_amount ?? row.lm_amount);
    if (!Number.isFinite(ngnAmount) || ngnAmount <= 0) continue;

    await db.none(
      `UPDATE wallet_transactions
       SET reason = $2,
           receive_amount = $3,
           send_amount = COALESCE($4::numeric, send_amount),
           ledger_currency = 'NGN',
           receive_channel = 'bank',
           activity_kind = 'deposit',
           status = 'success-collection'
       WHERE id = $1`,
      [
        row.id,
        NGN_BANK_DEPOSIT_REASON,
        ngnAmount,
        Number(row.lm_amount) > 0 ? Number(row.lm_amount) : null,
      ]
    );
    repaired += 1;
  }

  return { repaired };
}
