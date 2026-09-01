/**
 * Infra org-scoped bill payments — Flutterwave via billsService catalog/validate,
 * org ledger lock → pay → finalize | release (same lifecycle as payouts).
 */

import crypto from 'node:crypto';
import { db } from '../../config/database';
import { billsService } from '../payment/billsService';
import {
  createBillPayment,
  fetchBillPaymentStatus,
  mapFlutterwaveBillErrorMessage,
} from '../payment/flutterwaveService';
import {
  finalizePayoutDebit,
  lockPayoutFunds,
  releasePayoutLock,
  resolveUsdcAmount,
} from './infraLifecycleService';
import { getOrgBalance, InfraLedgerError } from './infraLedgerService';
import { simulateSettlement } from './infraMoneyService';

export type InfraEnv = 'test' | 'live';

export class InfraBillError extends Error {
  code: string;
  status: number;
  transactionId?: string;

  constructor(message: string, code: string, status = 400, transactionId?: string) {
    super(message);
    this.name = 'InfraBillError';
    this.code = code;
    this.status = status;
    this.transactionId = transactionId;
  }
}

const SKIP_VALIDATE_CATEGORIES = new Set(['AIRTIME', 'MOBILEDATA']);

type BillProvider = {
  createBillPayment: typeof createBillPayment;
  fetchBillPaymentStatus: typeof fetchBillPaymentStatus;
};

const defaultBillProvider: BillProvider = {
  createBillPayment,
  fetchBillPaymentStatus,
};

let billProvider: BillProvider = defaultBillProvider;

/** Test hook — inject failing/success Flutterwave responses without hitting the network. */
export function __setBillProviderForTests(provider: Partial<BillProvider> | null): void {
  billProvider = provider ? { ...defaultBillProvider, ...provider } : defaultBillProvider;
}

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

function friendlyBillError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return mapFlutterwaveBillErrorMessage(
    msg,
    'Unable to complete this bill payment — please check the details and try again.'
  );
}

function shouldSimulateBillOnProviderFailure(env: InfraEnv): boolean {
  return env === 'test' && process.env.INFRA_BILLS_TEST_NO_SIMULATE !== '1';
}

/** Classify Flutterwave bill pay outcome — electricity/cable can return pending. */
export function resolveFlutterwaveBillOutcome(
  fwResult: Record<string, unknown> | null,
  statusData: Record<string, unknown> | null
): 'success' | 'pending' | 'failed' {
  const tokens = [
    statusData?.status,
    statusData?.processor_response,
    statusData?.response_message,
    fwResult?.status,
    fwResult?.message,
  ]
    .map((v) => String(v || '').toLowerCase())
    .filter(Boolean);

  if (tokens.some((s) => /failed|error|invalid|declined/.test(s))) {
    return 'failed';
  }
  if (tokens.some((s) => /pending|processing|in.?progress|queued/.test(s))) {
    return 'pending';
  }
  if (tokens.some((s) => /success|successful|completed|delivered/.test(s))) {
    return 'success';
  }
  // createBillPayment threw on hard failures; a clean response is treated as success.
  return fwResult ? 'success' : 'failed';
}

async function insertBillTx(input: {
  orgId: string;
  env: InfraEnv;
  amount: number;
  currency: string;
  status: string;
  externalId: string;
  metadata: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const idem = String(input.idempotencyKey || '').trim() || null;
  if (idem) {
    const existing = await db.oneOrNone<{ id: string }>(
      `SELECT id::text AS id FROM infra_transactions
       WHERE org_id = $1 AND environment = $2 AND client_idempotency_key = $3
       ORDER BY created_at DESC LIMIT 1`,
      [input.orgId, input.env, idem]
    );
    if (existing) {
      const row = await loadBillTx(existing.id, input.orgId);
      if (!row) {
        throw new InfraBillError('Bill transaction not found', 'NOT_FOUND', 404);
      }
      return { row, idempotentReplay: true };
    }
  }

  const row = await db.one<{
    id: string;
    amount: string;
    currency: string;
    status: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, country, status, method, direction,
        external_id, metadata, client_idempotency_key)
     VALUES ($1, $2, $3, 'NGN', 'NG', $4, 'bill_pay', 'payout', $5, $6::jsonb, $7)
     RETURNING id::text AS id, amount::text, currency, status, external_id, metadata`,
    [
      input.orgId,
      input.env,
      input.amount,
      input.status,
      input.externalId,
      JSON.stringify(input.metadata),
      idem,
    ]
  );
  return { row, idempotentReplay: false };
}

async function loadBillTx(id: string, orgId: string) {
  return db.oneOrNone<{
    id: string;
    amount: string;
    currency: string;
    status: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id::text AS id, amount::text, currency, status, external_id, metadata
     FROM infra_transactions WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
}

function mapBillResult(
  row: {
    id: string;
    amount: string;
    currency: string;
    status: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
  },
  extra: Record<string, unknown> = {}
) {
  const meta = row.metadata || {};
  return {
    id: row.id,
    transactionId: row.id,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    reference: meta.reference || row.external_id,
    categoryCode: meta.categoryCode,
    billerCode: meta.billerCode,
    itemCode: meta.itemCode,
    customerId: meta.customerId,
    customerName: meta.validatedCustomerName || meta.customerName,
    billerName: meta.billerName,
    itemName: meta.itemName,
    usdcAmount: meta.usdcAmount,
    rechargeToken: meta.rechargeToken ?? null,
    ...extra,
  };
}

/** Release locked funds and mark the bill tx failed — always attempt release. */
async function failLockedBillPayment(input: {
  orgId: string;
  transactionId: string;
  reason: string;
  code: string;
  status?: number;
  metadataPatch?: Record<string, unknown>;
}): Promise<never> {
  try {
    await releasePayoutLock({
      orgId: input.orgId,
      transactionId: input.transactionId,
      source: 'bill_pay_failure',
      status: 'failed',
    });
  } catch (releaseErr) {
    await db.none(
      `UPDATE infra_transactions SET metadata = metadata || $2::jsonb WHERE id = $1`,
      [
        input.transactionId,
        JSON.stringify({
          releaseLockError:
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          needsManualRelease: true,
          failureReason: input.reason,
        }),
      ]
    );
    throw new InfraBillError(
      'Bill payment failed and funds could not be released automatically — contact support',
      'RELEASE_FAILED',
      502,
      input.transactionId
    );
  }

  await db.none(
    `UPDATE infra_transactions SET status = 'failed', metadata = metadata || $2::jsonb WHERE id = $1`,
    [
      input.transactionId,
      JSON.stringify({
        failureReason: input.reason,
        ...(input.metadataPatch || {}),
      }),
    ]
  );
  throw new InfraBillError(input.reason, input.code, input.status ?? 502, input.transactionId);
}

async function completeBillSettlement(input: {
  orgId: string;
  transactionId: string;
  fwResult: Record<string, unknown> | null;
  statusData: Record<string, unknown> | null;
  rechargeToken: unknown;
}) {
  const settled = await finalizePayoutDebit({
    orgId: input.orgId,
    transactionId: input.transactionId,
    source: 'bill_pay',
  });
  await db.none(
    `UPDATE infra_transactions SET status = 'settled', metadata = metadata || $2::jsonb WHERE id = $1`,
    [
      input.transactionId,
      JSON.stringify({
        flutterwave: input.fwResult,
        billStatus: input.statusData,
        rechargeToken: input.rechargeToken,
        providerPaid: true,
        settledAt: new Date().toISOString(),
      }),
    ]
  );
  const updated = await loadBillTx(input.transactionId, input.orgId);
  return {
    row: updated!,
    balance: settled.balance,
  };
}

async function markBillProcessing(input: {
  transactionId: string;
  fwResult: Record<string, unknown> | null;
  statusData: Record<string, unknown> | null;
  rechargeToken?: unknown;
  extra?: Record<string, unknown>;
}) {
  await db.none(
    `UPDATE infra_transactions SET status = 'processing', metadata = metadata || $2::jsonb WHERE id = $1`,
    [
      input.transactionId,
      JSON.stringify({
        flutterwave: input.fwResult,
        billStatus: input.statusData,
        rechargeToken: input.rechargeToken ?? null,
        providerPaid: true,
        ...(input.extra || {}),
      }),
    ]
  );
}

export async function listInfraBillCategories() {
  return billsService.getCategories();
}

export async function listInfraBillBillers(categoryCode: string) {
  return billsService.getBillers(categoryCode);
}

export async function listInfraBillItems(billerCode: string) {
  return billsService.getItems(billerCode);
}

export async function validateInfraBill(input: {
  categoryCode: string;
  billerCode: string;
  itemCode: string;
  customerId: string;
}) {
  const data = await billsService.validateBill(input);
  if ((data as Record<string, unknown>).skipped === true) {
    return { ...data, skipped: true };
  }
  const customerName =
    (data as Record<string, unknown>).customer_name ??
    (data as Record<string, unknown>).CustomerName ??
    (data as Record<string, unknown>).name;
  return {
    ...data,
    customerName: customerName != null ? String(customerName) : undefined,
  };
}

export type PayInfraBillInput = {
  orgId: string;
  env: InfraEnv | string;
  idempotencyKey?: string;
  categoryCode: string;
  billerCode: string;
  itemCode: string;
  customerId: string;
  amount: number;
  billerName?: string;
  itemName?: string;
};

export async function payInfraBill(input: PayInfraBillInput) {
  const env = asEnv(String(input.env));
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InfraBillError('Invalid bill amount', 'INVALID_AMOUNT');
  }

  const category = String(input.categoryCode || '').toUpperCase();
  const reference = `dayfi-infra-bill-${crypto.randomUUID()}`;
  const { usdcAmount, rate } = await resolveUsdcAmount(amount, 'NGN');

  const balance = await getOrgBalance(input.orgId, env);
  if (balance.available + 1e-9 < usdcAmount) {
    throw new InfraBillError(
      'Insufficient available balance for this bill payment',
      'INSUFFICIENT_BALANCE',
      402
    );
  }

  const billMeta = {
    type: 'bill_pay',
    categoryCode: category,
    billerCode: input.billerCode,
    itemCode: input.itemCode,
    customerId: input.customerId,
    billerName: input.billerName,
    itemName: input.itemName,
    reference,
    usdcAmount,
    rate,
  };

  const { row, idempotentReplay } = await insertBillTx({
    orgId: input.orgId,
    env,
    amount,
    currency: 'NGN',
    status: env === 'test' ? 'processing' : 'pending',
    externalId: reference,
    metadata: billMeta,
    idempotencyKey: input.idempotencyKey,
  });

  if (!row) {
    throw new InfraBillError('Bill transaction not found', 'NOT_FOUND', 404);
  }

  if (idempotentReplay) {
    return { ...mapBillResult(row), idempotentReplay: true };
  }

  let fundsLocked = false;
  try {
    await lockPayoutFunds({
      orgId: input.orgId,
      transactionId: row.id,
      usdcAmount,
    });
    fundsLocked = true;
  } catch (err) {
    await db.none(
      `UPDATE infra_transactions SET status = 'failed', metadata = metadata || $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify({ error: 'Unable to lock funds' })]
    );
    if (err instanceof InfraLedgerError) {
      throw new InfraBillError(err.message, err.code || 'LEDGER_ERROR', err.status, row.id);
    }
    throw err;
  }

  if (!SKIP_VALIDATE_CATEGORIES.has(category)) {
    try {
      const validation = await validateInfraBill({
        categoryCode: category,
        billerCode: input.billerCode,
        itemCode: input.itemCode,
        customerId: input.customerId,
      });
      const validatedName =
        'customerName' in validation ? validation.customerName : undefined;
      await db.none(
        `UPDATE infra_transactions SET metadata = metadata || $2::jsonb WHERE id = $1`,
        [
          row.id,
          JSON.stringify({
            validatedCustomerName: validatedName,
            validation,
          }),
        ]
      );
    } catch (err) {
      await failLockedBillPayment({
        orgId: input.orgId,
        transactionId: row.id,
        reason: friendlyBillError(err),
        code: 'VALIDATION_FAILED',
        status: 400,
        metadataPatch: { validationError: friendlyBillError(err) },
      });
    }
  }

  let fwResult: Record<string, unknown> | null = null;
  try {
    fwResult = await billProvider.createBillPayment({
      billerCode: input.billerCode,
      itemCode: input.itemCode,
      customerId: input.customerId,
      amount,
      reference,
      country: 'NG',
    });
  } catch (err) {
    if (shouldSimulateBillOnProviderFailure(env)) {
      const settled = await simulateSettlement({
        orgId: input.orgId,
        env: 'test',
        transactionId: row.id,
      });
      const updated = await loadBillTx(row.id, input.orgId);
      return {
        ...mapBillResult(updated!, {
          idempotentReplay: false,
          testSimulated: true,
          balance: settled.balance,
        }),
      };
    }
    await failLockedBillPayment({
      orgId: input.orgId,
      transactionId: row.id,
      reason: friendlyBillError(err),
      code: 'PROVIDER_FAILED',
      status: 502,
      metadataPatch: { providerError: friendlyBillError(err) },
    });
  }

  let statusData: Record<string, unknown> | null = null;
  const fwTxRef = String(fwResult?.tx_ref ?? fwResult?.flw_ref ?? reference).trim();
  if (fwTxRef) {
    try {
      statusData = await billProvider.fetchBillPaymentStatus(fwTxRef);
    } catch {
      statusData = null;
    }
  }

  const outcome = resolveFlutterwaveBillOutcome(fwResult, statusData);
  const rechargeToken = statusData?.extra ?? fwResult?.recharge_token ?? null;

  if (outcome === 'failed') {
    await failLockedBillPayment({
      orgId: input.orgId,
      transactionId: row.id,
      reason: 'Bill provider rejected this payment',
      code: 'PROVIDER_FAILED',
      status: 502,
      metadataPatch: { flutterwave: fwResult, billStatus: statusData },
    });
  }

  if (outcome === 'pending') {
    await markBillProcessing({
      transactionId: row.id,
      fwResult,
      statusData,
      rechargeToken,
    });
    const updated = await loadBillTx(row.id, input.orgId);
    return {
      ...mapBillResult(updated!, {
        idempotentReplay: false,
        pendingProvider: true,
      }),
    };
  }

  try {
    const { row: updated, balance } = await completeBillSettlement({
      orgId: input.orgId,
      transactionId: row.id,
      fwResult,
      statusData,
      rechargeToken,
    });
    return {
      ...mapBillResult(updated, {
        flutterwave: fwResult,
        status: statusData,
        rechargeToken,
        balance,
      }),
    };
  } catch (err) {
    // Provider already accepted payment — never release the lock; leave funds locked for retry.
    await markBillProcessing({
      transactionId: row.id,
      fwResult,
      statusData,
      rechargeToken,
      extra: {
        settleError: err instanceof Error ? err.message : String(err),
        needsSettleRetry: true,
      },
    });
    const updated = await loadBillTx(row.id, input.orgId);
    return {
      ...mapBillResult(updated!, {
        idempotentReplay: false,
        settlePending: true,
        message:
          'Bill payment submitted — settlement is still processing. Check status shortly.',
      }),
    };
  } finally {
    void fundsLocked;
  }
}

/** Poll Flutterwave / retry finalize for processing bill payments. */
export async function refreshInfraBillStatus(orgId: string, reference: string) {
  const row = await db.oneOrNone<{
    id: string;
    amount: string;
    currency: string;
    status: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id::text AS id, amount::text, currency, status, external_id, metadata
     FROM infra_transactions
     WHERE org_id = $1 AND direction = 'payout' AND method = 'bill_pay'
       AND (external_id = $2 OR metadata->>'reference' = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [orgId, reference]
  );
  if (!row) throw new InfraBillError('Bill payment not found', 'NOT_FOUND', 404);

  const status = String(row.status).toLowerCase();
  if (status === 'settled' || status === 'failed') {
    return mapBillResult(row);
  }

  const meta = row.metadata || {};
  const fwResult = (meta.flutterwave as Record<string, unknown> | undefined) ?? null;
  const fwTxRef = String(
    fwResult?.tx_ref ?? fwResult?.flw_ref ?? meta.reference ?? row.external_id ?? ''
  ).trim();

  let statusData: Record<string, unknown> | null =
    (meta.billStatus as Record<string, unknown> | undefined) ?? null;

  if (fwTxRef) {
    try {
      statusData = await billProvider.fetchBillPaymentStatus(fwTxRef);
    } catch {
      statusData = statusData ?? null;
    }
  }

  const outcome = resolveFlutterwaveBillOutcome(fwResult, statusData);
  const rechargeToken = statusData?.extra ?? fwResult?.recharge_token ?? meta.rechargeToken ?? null;

  if (outcome === 'failed' && meta.fundsFinalized !== true && meta.fundsReleased !== true) {
    await failLockedBillPayment({
      orgId,
      transactionId: row.id,
      reason: 'Bill provider reported payment failed',
      code: 'PROVIDER_FAILED',
      status: 502,
      metadataPatch: { billStatus: statusData },
    });
  }

  if (outcome === 'pending') {
    await markBillProcessing({
      transactionId: row.id,
      fwResult,
      statusData,
      rechargeToken,
    });
    const updated = await loadBillTx(row.id, orgId);
    return mapBillResult(updated!);
  }

  if (meta.fundsFinalized === true) {
    return mapBillResult(row);
  }

  try {
    const { row: updated } = await completeBillSettlement({
      orgId,
      transactionId: row.id,
      fwResult,
      statusData,
      rechargeToken,
    });
    return mapBillResult(updated);
  } catch {
    const updated = await loadBillTx(row.id, orgId);
    return mapBillResult(updated!);
  }
}

export async function getInfraBillStatus(orgId: string, reference: string) {
  return refreshInfraBillStatus(orgId, reference);
}
