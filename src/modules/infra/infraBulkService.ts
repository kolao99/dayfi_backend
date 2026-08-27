/**
 * Phase 4 — Bulk payment orchestration.
 *
 * Rule: the parent batch NEVER touches the wallet ledger.
 * Only child payouts run Phase 2 (lock → provider → finalize/release).
 *
 * Flow: draft → preflight → confirm → createPayout per item → aggregate.
 */

import crypto from 'crypto';
import { db } from '../../config/database';
import { getOrgBalance } from './infraLedgerService';
import { resolveUsdcAmount } from './infraLifecycleService';
import { createPayout, simulateSettlement } from './infraMoneyService';
import {
  normalizeRail,
  resolveDestinationForPayout,
  type DestinationRail,
} from './infraRecipientService';

export type InfraEnv = 'test' | 'live';

export type BulkBatchStatus =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'processing'
  | 'partially_completed'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BulkItemStatus =
  | 'pending'
  | 'invalid'
  | 'ready'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export class InfraBulkError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraBulkError';
    this.code = code;
    this.status = status;
  }
}

export type BulkItemInput = {
  recipientId: string;
  destinationId?: string;
  amount: number;
  currency?: string;
  instruction?: Record<string, unknown>;
};

type BatchRow = {
  id: string;
  org_id: string;
  environment: string;
  batch_code: string;
  label: string | null;
  status: string;
  source: string;
  currency: string;
  item_count: number;
  total_usdc: string;
  fee_usdc: string;
  completed_usdc: string;
  released_usdc: string;
  locked_usdc: string;
  completed_count: number;
  failed_count: number;
  processing_count: number;
  preflight: Record<string, unknown>;
  metadata: Record<string, unknown>;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ItemRow = {
  id: string;
  batch_id: string;
  org_id: string;
  line_number: number;
  recipient_id: string | null;
  destination_id: string | null;
  amount: string;
  currency: string;
  usdc_amount: string | null;
  fee_usdc: string;
  fx_rate: string | null;
  status: string;
  validation_errors: unknown;
  payout_transaction_id: string | null;
  instruction: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

const SUPPORTED_RAILS = new Set<DestinationRail>([
  'bank',
  'mobile_money',
  'crypto',
  'dayfi',
]);

const BATCH_SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment, batch_code, label,
  status, source, currency, item_count, total_usdc::text, fee_usdc::text,
  completed_usdc::text, released_usdc::text, locked_usdc::text,
  completed_count, failed_count, processing_count, preflight, metadata,
  confirmed_at, created_at, updated_at
 FROM infra_bulk_batches`;

const ITEM_SELECT = `SELECT id::text AS id, batch_id::text AS batch_id, org_id::text AS org_id,
  line_number, recipient_id::text AS recipient_id, destination_id::text AS destination_id,
  amount::text, currency, usdc_amount::text, fee_usdc::text, fx_rate::text,
  status, validation_errors, payout_transaction_id::text AS payout_transaction_id,
  instruction, metadata, created_at, updated_at
 FROM infra_bulk_items`;

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

function num(v: string | number | null | undefined): number {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function makeBatchCode(): string {
  return `BATCH_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function mapBatch(row: BatchRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment,
    batchCode: row.batch_code,
    label: row.label,
    status: row.status as BulkBatchStatus,
    source: row.source,
    currency: row.currency,
    itemCount: row.item_count,
    totalUsdc: num(row.total_usdc),
    feeUsdc: num(row.fee_usdc),
    completedUsdc: num(row.completed_usdc),
    releasedUsdc: num(row.released_usdc),
    lockedUsdc: num(row.locked_usdc),
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    processingCount: row.processing_count,
    preflight: row.preflight || {},
    metadata: row.metadata || {},
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: ItemRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    orgId: row.org_id,
    lineNumber: row.line_number,
    recipientId: row.recipient_id,
    destinationId: row.destination_id,
    amount: num(row.amount),
    currency: row.currency,
    usdcAmount: row.usdc_amount != null ? num(row.usdc_amount) : null,
    feeUsdc: num(row.fee_usdc),
    fxRate: row.fx_rate != null ? num(row.fx_rate) : null,
    status: row.status as BulkItemStatus,
    validationErrors: Array.isArray(row.validation_errors)
      ? row.validation_errors
      : [],
    payoutTransactionId: row.payout_transaction_id,
    instruction: row.instruction || {},
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadBatch(orgId: string, batchId: string): Promise<BatchRow> {
  const row = await db.oneOrNone<BatchRow>(
    `${BATCH_SELECT} WHERE id = $1 AND org_id = $2`,
    [batchId, orgId]
  );
  if (!row) throw new InfraBulkError('Batch not found', 'NOT_FOUND', 404);
  return row;
}

async function listItems(batchId: string): Promise<ItemRow[]> {
  return db.manyOrNone<ItemRow>(
    `${ITEM_SELECT} WHERE batch_id = $1 ORDER BY line_number ASC`,
    [batchId]
  );
}

async function getBatchWithItems(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  const items = await listItems(batchId);
  return { ...mapBatch(batch), items: items.map(mapItem) };
}

/** Parse CSV with header row. Supports quoted fields. */
export function parseBulkCsv(csvText: string): Record<string, string>[] {
  const text = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new InfraBulkError('CSV is empty', 'EMPTY_CSV');

  const lines: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.trim() || lines.length) lines.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length) lines.push(cur);

  const splitRow = (line: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = !q;
        continue;
      }
      if (ch === ',' && !q) {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  };

  const header = splitRow(lines[0]).map((h) =>
    h.toLowerCase().replace(/\s+/g, '_')
  );
  if (!header.length) throw new InfraBulkError('CSV has no header', 'INVALID_CSV');

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitRow(lines[i]);
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    rows.push(obj);
  }
  return rows;
}

export function csvRowsToItems(rows: Record<string, string>[]): BulkItemInput[] {
  return rows.map((r) => {
    const recipientId = String(
      r.recipient_id || r.recipientid || r.recipient || ''
    ).trim();
    const destinationId = String(
      r.destination_id || r.destinationid || r.destination || ''
    ).trim();
    return {
      recipientId,
      destinationId: destinationId || undefined,
      amount: Number(r.amount || r.value || 0),
      currency: String(r.currency || r.asset || 'USDC').toUpperCase(),
      instruction: { ...r },
    };
  });
}

export async function createBulkBatch(input: {
  orgId: string;
  environment: InfraEnv | string;
  label?: string;
  source?: 'api' | 'csv' | 'recipients';
  items: BulkItemInput[];
  runPreflight?: boolean;
}) {
  const env = asEnv(String(input.environment));
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new InfraBulkError('At least one item is required', 'EMPTY_BATCH');
  }
  if (input.items.length > 2000) {
    throw new InfraBulkError('Batch limited to 2000 items', 'BATCH_TOO_LARGE');
  }

  const batch = await db.one<BatchRow>(
    `INSERT INTO infra_bulk_batches
       (org_id, environment, batch_code, label, status, source, item_count)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)
     RETURNING id::text AS id, org_id::text AS org_id, environment, batch_code, label,
               status, source, currency, item_count, total_usdc::text, fee_usdc::text,
               completed_usdc::text, released_usdc::text, locked_usdc::text,
               completed_count, failed_count, processing_count, preflight, metadata,
               confirmed_at, created_at, updated_at`,
    [
      input.orgId,
      env,
      makeBatchCode(),
      input.label || null,
      input.source || 'api',
      input.items.length,
    ]
  );

  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    await db.none(
      `INSERT INTO infra_bulk_items
         (batch_id, org_id, line_number, recipient_id, destination_id, amount, currency,
          status, instruction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb)`,
      [
        batch.id,
        input.orgId,
        i + 1,
        it.recipientId || null,
        it.destinationId || null,
        Number(it.amount),
        String(it.currency || 'USDC').toUpperCase(),
        JSON.stringify(it.instruction || {}),
      ]
    );
  }

  if (input.runPreflight !== false) {
    return runPreflight(input.orgId, batch.id);
  }
  return getBatchWithItems(input.orgId, batch.id);
}

export async function importBulkCsv(input: {
  orgId: string;
  environment: InfraEnv | string;
  csvText: string;
  label?: string;
}) {
  const rows = parseBulkCsv(input.csvText);
  const items = csvRowsToItems(rows);
  return createBulkBatch({
    orgId: input.orgId,
    environment: input.environment,
    label: input.label || 'CSV import',
    source: 'csv',
    items,
    runPreflight: true,
  });
}

export async function listBulkBatches(
  orgId: string,
  environment: InfraEnv | string,
  opts?: { limit?: number }
) {
  const env = asEnv(String(environment));
  const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 100);
  const rows = await db.manyOrNone<BatchRow>(
    `${BATCH_SELECT}
     WHERE org_id = $1 AND environment = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [orgId, env, limit]
  );
  return rows.map(mapBatch);
}

export async function getBulkBatch(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  if (['processing', 'partially_completed'].includes(batch.status)) {
    await refreshBatchAggregates(orgId, batchId);
  }
  return getBatchWithItems(orgId, batchId);
}

type CheckResult = { ok: boolean; code: string; message: string };

/**
 * Validate the entire batch before locking anything.
 * Sets items ready/invalid; batch → ready (all ok) or draft (errors).
 */
export async function runPreflight(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  if (!['draft', 'validating', 'ready'].includes(batch.status)) {
    throw new InfraBulkError(
      `Cannot preflight a ${batch.status} batch`,
      'INVALID_STATE'
    );
  }

  await db.none(
    `UPDATE infra_bulk_batches SET status = 'validating', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [batchId]
  );

  const items = await listItems(batchId);
  const checks: CheckResult[] = [];
  const seenKeys = new Set<string>();
  let totalUsdc = 0;
  let feeUsdc = 0;
  let validCount = 0;
  let invalidCount = 0;

  for (const item of items) {
    const errors: string[] = [];
    const amount = num(item.amount);
    const currency = String(item.currency || 'USDC').toUpperCase();

    if (!item.recipient_id) errors.push('recipient_id is required');
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push('amount must be greater than zero');
    }

    let usdcAmount: number | null = null;
    let fxRate: number | null = null;
    let destId = item.destination_id;
    let rail: string | null = null;

    if (item.recipient_id && amount > 0) {
      try {
        const resolved = await resolveDestinationForPayout({
          orgId,
          environment: batch.environment,
          recipientId: item.recipient_id,
          destinationId: item.destination_id || undefined,
        });
        destId = resolved.destination.id;
        rail = resolved.destination.rail;
        const normalized = normalizeRail(String(rail));
        if (!SUPPORTED_RAILS.has(normalized)) {
          errors.push(`unsupported rail: ${rail}`);
        }

        const fx = await resolveUsdcAmount(amount, currency);
        usdcAmount = fx.usdcAmount;
        fxRate = fx.rate;
        if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
          errors.push('FX quote unavailable or invalid');
        }
      } catch (err: any) {
        errors.push(err?.message || 'Unable to resolve recipient destination');
      }
    }

    const dupKey = `${item.recipient_id || ''}:${destId || ''}:${amount}:${currency}`;
    if (seenKeys.has(dupKey)) {
      errors.push('duplicate recipient/destination/amount instruction');
    } else {
      seenKeys.add(dupKey);
    }

    const itemFee = 0;
    const status: BulkItemStatus = errors.length ? 'invalid' : 'ready';
    if (status === 'ready' && usdcAmount != null) {
      totalUsdc += usdcAmount;
      feeUsdc += itemFee;
      validCount++;
    } else {
      invalidCount++;
    }

    await db.none(
      `UPDATE infra_bulk_items SET
         destination_id = COALESCE($3, destination_id),
         usdc_amount = $4,
         fee_usdc = $5,
         fx_rate = $6,
         status = $7,
         validation_errors = $8::jsonb,
         metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND batch_id = $2`,
      [
        item.id,
        batchId,
        destId,
        usdcAmount,
        itemFee,
        fxRate,
        status,
        JSON.stringify(errors),
        JSON.stringify({ rail }),
      ]
    );
  }

  const balance = await getOrgBalance(orgId, asEnv(batch.environment));
  const required = Math.round((totalUsdc + feeUsdc) * 1e7) / 1e7;
  const sufficient = balance.available + 1e-9 >= required;

  checks.push({
    ok: invalidCount === 0,
    code: 'ITEMS_VALID',
    message:
      invalidCount === 0
        ? `All ${validCount} items valid`
        : `${invalidCount} of ${items.length} items invalid`,
  });
  checks.push({
    ok: validCount > 0,
    code: 'HAS_VALID_ITEMS',
    message:
      validCount > 0
        ? `${validCount} payments ready`
        : 'No valid payments in batch',
  });
  checks.push({
    ok: sufficient,
    code: 'SUFFICIENT_BALANCE',
    message: sufficient
      ? `Available ${balance.available} USDC covers ${required} USDC`
      : `Insufficient available balance: need ${required} USDC, have ${balance.available}`,
  });

  const allOk = checks.every((c) => c.ok);
  const preflight = {
    ok: allOk,
    checks,
    summary: {
      itemCount: items.length,
      validCount,
      invalidCount,
      totalUsdc: required,
      feeUsdc,
      availableUsdc: balance.available,
      message: allOk
        ? `${validCount} payments ready · $${required.toFixed(2)} total`
        : 'Preflight failed — fix items before confirm',
    },
    ranAt: new Date().toISOString(),
  };

  await db.none(
    `UPDATE infra_bulk_batches SET
       status = $2,
       total_usdc = $3,
       fee_usdc = $4,
       preflight = $5::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [batchId, allOk ? 'ready' : 'draft', required, feeUsdc, JSON.stringify(preflight)]
  );

  return getBatchWithItems(orgId, batchId);
}

/**
 * Confirm ready batch: create child payouts (Phase 2 locks each).
 * Parent never debits/locks the ledger itself.
 */
export async function confirmBulkBatch(
  orgId: string,
  batchId: string,
  opts?: { autoSimulateTest?: boolean }
) {
  const batch = await loadBatch(orgId, batchId);
  if (batch.status !== 'ready') {
    throw new InfraBulkError(
      'Batch must be READY (pass preflight) before confirm',
      'NOT_READY'
    );
  }

  const items = (await listItems(batchId)).filter((i) => i.status === 'ready');
  if (!items.length) {
    throw new InfraBulkError('No ready items to confirm', 'EMPTY_READY');
  }

  const required = items.reduce((s, i) => s + num(i.usdc_amount), 0);
  const balance = await getOrgBalance(orgId, asEnv(batch.environment));
  if (balance.available + 1e-9 < required) {
    throw new InfraBulkError(
      `Insufficient available balance to confirm: need ${required}, have ${balance.available}`,
      'INSUFFICIENT_BALANCE'
    );
  }

  await db.none(
    `UPDATE infra_bulk_batches SET
       status = 'processing',
       confirmed_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [batchId]
  );

  const autoSimulate =
    opts?.autoSimulateTest !== false && asEnv(batch.environment) === 'test';

  for (const item of items) {
    try {
      const payout = await createPayout({
        orgId,
        env: asEnv(batch.environment),
        amount: num(item.amount),
        currency: item.currency,
        recipientId: item.recipient_id!,
        destinationId: item.destination_id || undefined,
        bulkBatchId: batchId,
        bulkItemId: item.id,
        idempotencyKey: `bulk:${batchId}:item:${item.id}`,
      });

      await db.none(
        `UPDATE infra_bulk_items SET
           payout_transaction_id = $3,
           status = 'processing',
           usdc_amount = COALESCE($4, usdc_amount),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND batch_id = $2`,
        [item.id, batchId, payout.id, payout.usdcAmount ?? null]
      );

      if (autoSimulate) {
        try {
          await simulateSettlement({
            orgId,
            env: 'test',
            transactionId: payout.id,
          });
          await db.none(
            `UPDATE infra_bulk_items SET status = 'completed', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [item.id]
          );
        } catch (simErr: any) {
          await db.none(
            `UPDATE infra_bulk_items SET
               status = 'failed',
               metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [
              item.id,
              JSON.stringify({
                simulateError: simErr?.message || 'simulate failed',
              }),
            ]
          );
        }
      }
    } catch (err: any) {
      await db.none(
        `UPDATE infra_bulk_items SET
           status = 'failed',
           validation_errors = $3::jsonb,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND batch_id = $2`,
        [
          item.id,
          batchId,
          JSON.stringify([err?.message || 'Payout create failed']),
        ]
      );
    }
  }

  await refreshBatchAggregates(orgId, batchId);
  return getBatchWithItems(orgId, batchId);
}

export async function cancelBulkBatch(orgId: string, batchId: string) {
  const batch = await loadBatch(orgId, batchId);
  if (!['draft', 'ready', 'validating'].includes(batch.status)) {
    throw new InfraBulkError(
      `Cannot cancel a ${batch.status} batch`,
      'INVALID_STATE'
    );
  }
  await db.none(
    `UPDATE infra_bulk_batches SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [batchId]
  );
  await db.none(
    `UPDATE infra_bulk_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE batch_id = $1 AND status IN ('pending', 'ready', 'invalid')`,
    [batchId]
  );
  return getBatchWithItems(orgId, batchId);
}

/**
 * Sync item statuses from child payout txs; roll up parent money totals.
 * completed / released / locked come from Phase 2 outcomes only.
 */
export async function refreshBatchAggregates(orgId: string, batchId: string) {
  const current = await loadBatch(orgId, batchId);
  if (current.status === 'cancelled') {
    return getBatchWithItems(orgId, batchId);
  }

  const items = await listItems(batchId);
  let completedUsdc = 0;
  let releasedUsdc = 0;
  let lockedUsdc = 0;
  let completedCount = 0;
  let failedCount = 0;
  let processingCount = 0;

  for (const item of items) {
    if (!item.payout_transaction_id) {
      if (item.status === 'failed' || item.status === 'invalid') failedCount++;
      continue;
    }

    const tx = await db.oneOrNone<{
      status: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT status, metadata FROM infra_transactions WHERE id = $1 AND org_id = $2`,
      [item.payout_transaction_id, orgId]
    );
    if (!tx) continue;

    const usdc = num((tx.metadata?.usdcAmount as number) ?? item.usdc_amount ?? 0);
    const st = String(tx.status).toLowerCase();
    let itemStatus: BulkItemStatus = item.status as BulkItemStatus;

    if (['settled', 'completed', 'success', 'successful'].includes(st)) {
      itemStatus = 'completed';
      completedUsdc += usdc;
      completedCount++;
    } else if (['failed', 'cancelled', 'expired', 'rejected'].includes(st)) {
      itemStatus = 'failed';
      releasedUsdc += usdc;
      failedCount++;
    } else {
      itemStatus = 'processing';
      lockedUsdc += usdc;
      processingCount++;
    }

    if (itemStatus !== item.status) {
      await db.none(
        `UPDATE infra_bulk_items SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [item.id, itemStatus]
      );
    }
  }

  let parentStatus: BulkBatchStatus = 'processing';
  if (processingCount > 0) {
    parentStatus = 'processing';
  } else if (completedCount > 0 && failedCount === 0) {
    parentStatus = 'completed';
  } else if (completedCount > 0 && failedCount > 0) {
    parentStatus = 'partially_completed';
  } else if (completedCount === 0 && failedCount > 0) {
    parentStatus = 'failed';
  }

  await db.none(
    `UPDATE infra_bulk_batches SET
       status = $2,
       completed_usdc = $3,
       released_usdc = $4,
       locked_usdc = $5,
       completed_count = $6,
       failed_count = $7,
       processing_count = $8,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      batchId,
      parentStatus,
      completedUsdc,
      releasedUsdc,
      lockedUsdc,
      completedCount,
      failedCount,
      processingCount,
    ]
  );

  return getBatchWithItems(orgId, batchId);
}
