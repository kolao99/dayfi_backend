import crypto from 'node:crypto';
import { db } from '../../config/database';
import {
  creditWalletBalance,
  newReference,
} from '../payment/balanceService';
import {
  convertAmountBetween,
  convertAmountToUsd,
} from '../payment/fxService';
import { PRIMARY_CURRENCY } from '../payment/walletModel';
import { createBudget, computeNextRunAt } from '../payment/budgetService';
import type { BudgetFrequency } from '../payment/budgetService';
import PaymentService from '../payment/services';
import { transferByDayfiTag } from '../payment/p2pService';
import { billsService } from '../payment/billsService';
import {
  buildSmartFlowTitle,
  inferFlowType,
  type NamingInput,
} from './dayflowFlowNaming';
import { validateSchedulesForCreate } from './dayflowFlowValidation';
import { resolveNextRunAtIso } from './dayflowDueDate';

export type DayflowFlowCategory = {
  name: string;
  allocated: number;
  spent?: number;
  locked?: boolean;
};

export type DayflowFlowSchedule = {
  id?: string;
  title: string;
  amount: number;
  sourceAmount?: number;
  frequency?: BudgetFrequency;
  dueLabel?: string;
  recipientHint?: string;
  recipientId?: string | null;
  paymentType?: 'send' | 'bill' | 'savings';
  autoPay?: boolean;
  budgetId?: string | null;
  nextRunAt?: string | null;
  execution?: {
    toCurrency?: string;
    bill?: {
      categoryCode: string;
      billerCode: string;
      itemCode: string;
      customerId: string;
      billerName?: string;
      itemName?: string;
    };
  };
  lastRunAt?: string | null;
  lastStatus?: 'success' | 'failed' | null;
  lastError?: string | null;
  runCount?: number;
};

export type CreateFlowInput = {
  title?: string;
  periodLabel?: string;
  budgetType?: string;
  categories?: DayflowFlowCategory[];
  schedules?: DayflowFlowSchedule[];
  currency?: string;
  summaryLine?: string;
  metadata?: {
    endsAt?: string;
  };
};

type FlowRow = {
  id: string;
  user_id: string;
  title: string;
  flow_type: string;
  status: string;
  total_amount: string;
  held_amount: string;
  spent_amount: string;
  currency: string;
  categories: unknown;
  schedules: unknown;
  metadata: unknown;
  hold_movement_id: string | null;
  release_movement_id: string | null;
  period_label: string | null;
  budget_type: string;
  summary_line: string | null;
  next_run_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

async function flowsTableReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.dayflow_flows') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

async function loadNgnWallet(userId: string) {
  return db.oneOrNone<{ wallet_id: string; balance: string }>(
    `SELECT wallet_id, balance::text AS balance FROM wallets
     WHERE user_id = $1 AND currency = 'NGN' LIMIT 1`,
    [userId]
  );
}

async function loadUsdWallet(userId: string) {
  return db.oneOrNone<{ wallet_id: string; balance: string }>(
    `SELECT wallet_id, balance::text AS balance FROM wallets
     WHERE user_id = $1 AND currency = $2 LIMIT 1`,
    [userId, PRIMARY_CURRENCY]
  );
}

async function loadWalletForCurrency(userId: string, currency: string) {
  const c = String(currency).toUpperCase();
  if (c === PRIMARY_CURRENCY) return loadUsdWallet(userId);
  if (c === 'NGN') return loadNgnWallet(userId);
  return null;
}

function formatFlow(row: FlowRow) {
  const categories = Array.isArray(row.categories) ? row.categories : [];
  const schedules = Array.isArray(row.schedules) ? row.schedules : [];
  const total = Number(row.total_amount);
  const held = Number(row.held_amount);
  const spent = Number(row.spent_amount);

  return {
    id: row.id,
    title: row.title,
    flowType: row.flow_type,
    status: row.status,
    totalAmount: total,
    heldAmount: held,
    spentAmount: spent,
    remainingAmount: Math.max(0, held - spent),
    currency: row.currency,
    categories,
    schedules,
    metadata:
      row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    periodLabel: row.period_label,
    budgetType: row.budget_type,
    summaryLine: row.summary_line,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sumCategories(categories: DayflowFlowCategory[]): number {
  return categories.reduce((s, c) => s + Number(c.allocated ?? 0), 0);
}

function sumSchedules(schedules: DayflowFlowSchedule[]): number {
  return schedules.reduce((s, x) => s + Number(x.amount ?? 0), 0);
}

function earliestNextRun(schedules: DayflowFlowSchedule[]): Date | null {
  let earliest: Date | null = null;
  for (const s of schedules) {
    if (!s.autoPay) continue;
    const explicit = parseScheduleNextRunAt(s);
    const freq = s.frequency ?? 'monthly';
    const next =
      explicit ??
      resolveNextRunAtIso({
        dueLabel: s.dueLabel,
        nextRunAt: s.nextRunAt,
        frequency: freq,
      });
    const parsed = next ? new Date(next) : computeNextRunAt(freq);
    if (!parsed || Number.isNaN(parsed.getTime())) continue;
    if (!earliest || parsed < earliest) earliest = parsed;
  }
  return earliest;
}

async function linkBudgetsForSchedules(
  userId: string,
  flowId: string,
  schedules: DayflowFlowSchedule[],
  currency: string = PRIMARY_CURRENCY,
  flowMetadata?: { endsAt?: string }
): Promise<DayflowFlowSchedule[]> {
  const updated: DayflowFlowSchedule[] = [];
  for (const s of schedules) {
    const copy = { ...s, id: s.id ?? crypto.randomUUID() };
    if (!copy.autoPay || copy.amount <= 0) {
      updated.push(copy);
      continue;
    }
    try {
      const freq = copy.frequency ?? 'monthly';
      const budget = await createBudget(userId, {
        name: copy.title,
        type: copy.paymentType === 'bill' ? 'bill_reminder' : 'recurring_send',
        amount: copy.amount,
        currency,
        frequency: freq,
        recipientId: copy.recipientId ?? null,
        nextRunAt: copy.nextRunAt ?? undefined,
        metadata: {
          dayflowFlowId: flowId,
          scheduleId: copy.id,
          recipientHint: copy.recipientHint,
          paymentType: copy.paymentType ?? 'send',
          ...(flowMetadata?.endsAt ? { endsAt: flowMetadata.endsAt } : {}),
        },
      });
      copy.budgetId = budget.id;
      copy.nextRunAt = copy.nextRunAt ?? budget.nextRunAt;
    } catch (err) {
      console.warn(
        `[dayflow] schedule budget link skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    updated.push(copy);
  }
  return updated;
}

async function cancelLinkedBudgets(flowId: string): Promise<void> {
  await db.none(
    `UPDATE budgets SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE metadata->>'dayflowFlowId' = $1 AND status NOT IN ('cancelled', 'completed')`,
    [flowId]
  );
}

const paymentService = new PaymentService();

function parseScheduleNextRunAt(s: DayflowFlowSchedule): Date | null {
  if (!s.nextRunAt) return null;
  const d = new Date(s.nextRunAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function computeScheduleNextRunAfterExecution(
  schedule: DayflowFlowSchedule
): Date | null {
  const freq = schedule.frequency ?? 'monthly';
  if (freq === 'once') return null;
  return computeNextRunAt(freq, new Date());
}

function isPayOnDueFlow(row: FlowRow): boolean {
  const meta =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  if (meta.payOnDue === true) return true;
  return !row.hold_movement_id;
}

async function executeSchedulePayment(params: {
  userId: string;
  walletId: string;
  flowId: string;
  flowTitle: string;
  schedule: DayflowFlowSchedule;
  payOnDue?: boolean;
  flowCurrency?: string;
}): Promise<void> {
  const { userId, walletId, flowId, flowTitle, schedule, payOnDue } = params;
  const flowCurrency = String(params.flowCurrency ?? PRIMARY_CURRENCY).toUpperCase();
  const amount = Number(schedule.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid schedule amount');
  }

  const paymentType = schedule.paymentType ?? 'send';

  if (!payOnDue) {
    const releaseRef = newReference('dayflow-exec-release');
    const { usdAmount } = await convertAmountToUsd(amount, flowCurrency);
    await creditWalletBalance({
      userId,
      walletId,
      amount,
      currency: flowCurrency,
      usdEquivalent: usdAmount,
      source: 'dayflow',
      idempotencyKey: `dayflow-exec-release:${flowId}:${schedule.id ?? schedule.title}`,
      externalReference: releaseRef,
      metadata: {
        dayflowAction: 'execution_release',
        flowId,
        flowTitle,
        scheduleId: schedule.id ?? null,
        scheduleTitle: schedule.title,
        paymentType,
      },
    });
  }

  if (paymentType === 'savings') {
    const toCurrency = String(schedule.execution?.toCurrency ?? 'USD').toUpperCase();
    await paymentService.swapCurrency(userId, flowCurrency, toCurrency, amount);
    return;
  }

  if (paymentType === 'bill') {
    const bill = schedule.execution?.bill;
    if (!bill?.categoryCode || !bill?.billerCode || !bill?.itemCode || !bill?.customerId) {
      throw new Error('Bill autopay requires biller, item and customer details');
    }
    const billAmount =
      flowCurrency === PRIMARY_CURRENCY
        ? (await convertAmountBetween(amount, PRIMARY_CURRENCY, 'NGN')).amount
        : amount;
    await billsService.payBill({
      userId,
      categoryCode: bill.categoryCode,
      billerCode: bill.billerCode,
      itemCode: bill.itemCode,
      customerId: bill.customerId,
      amount: billAmount,
      billerName: bill.billerName,
      itemName: bill.itemName ?? schedule.title,
    });
    return;
  }

  const recipientTag =
    (schedule.recipientId && String(schedule.recipientId).trim()) ||
    (schedule.recipientHint && String(schedule.recipientHint).trim());

  if (!recipientTag) {
    throw new Error('Send autopay requires recipientId or recipientHint');
  }

  await transferByDayfiTag({
    senderUserId: userId,
    senderWalletId: walletId,
    recipientDayfiId: recipientTag,
    amount,
    currency: flowCurrency,
  });
}

export async function listFlows(userId: string, status?: string) {
  if (!(await flowsTableReady())) return [];
  const rows = status
    ? await db.manyOrNone<FlowRow>(
        `SELECT * FROM dayflow_flows WHERE user_id = $1 AND status = $2
         ORDER BY created_at DESC`,
        [userId, status]
      )
    : await db.manyOrNone<FlowRow>(
        `SELECT * FROM dayflow_flows WHERE user_id = $1 AND status != 'cancelled'
         ORDER BY created_at DESC`,
        [userId]
      );
  return (rows ?? []).map(formatFlow);
}

export async function getFlow(userId: string, flowId: string) {
  if (!(await flowsTableReady())) return null;
  const row = await db.oneOrNone<FlowRow>(
    `SELECT * FROM dayflow_flows WHERE user_id = $1 AND id = $2`,
    [userId, flowId]
  );
  return row ? formatFlow(row) : null;
}

/**
 * Create a flow: register schedules and pay from the global USD wallet when each is due.
 */
export async function createAndActivateFlow(
  userId: string,
  input: CreateFlowInput
) {
  if (!(await flowsTableReady())) {
    throw new Error('DAYFLOW_FLOWS_TABLE_MISSING');
  }

  const categories = input.categories ?? [];
  let schedules = (input.schedules ?? []).map((s) => {
    const freq = s.frequency ?? 'monthly';
    const resolvedNext =
      s.nextRunAt ??
      resolveNextRunAtIso({
        dueLabel: s.dueLabel,
        nextRunAt: s.nextRunAt,
        frequency: freq,
      });
    return {
      ...s,
      id: s.id ?? crypto.randomUUID(),
      ...(resolvedNext ? { nextRunAt: resolvedNext } : {}),
    };
  });

  const scheduleCheck = validateSchedulesForCreate(schedules);
  if (!scheduleCheck.ok) {
    throw new Error(scheduleCheck.message);
  }

  let total =
    sumCategories(categories) > 0
      ? sumCategories(categories)
      : sumSchedules(schedules);

  if (total <= 0) {
    throw new Error('Flow total must be greater than zero');
  }

  const naming: NamingInput = {
    categories,
    schedules,
    periodLabel: input.periodLabel,
  };
  const title =
    input.title?.trim() || buildSmartFlowTitle(naming);
  const flowType = inferFlowType(naming);
  const currency = (input.currency ?? PRIMARY_CURRENCY).toUpperCase();

  if (currency !== PRIMARY_CURRENCY && currency !== 'NGN') {
    throw new Error('DayFlow envelopes support USD and NGN only');
  }

  const wallet = await loadWalletForCurrency(userId, currency);
  if (!wallet) {
    throw new Error(`${currency} wallet not found`);
  }

  const flowRef = newReference('dayflow-commit');
  const nextRunAt = earliestNextRun(schedules);
  const endsAt =
    typeof input.metadata?.endsAt === 'string' && input.metadata.endsAt.trim()
      ? input.metadata.endsAt.trim()
      : undefined;
  const flowMetadata = {
    payOnDue: true,
    commitRef: flowRef,
    ...(endsAt ? { endsAt } : {}),
  };

  const row = await db.one<FlowRow>(
    `INSERT INTO dayflow_flows (
      user_id, title, flow_type, status, total_amount, held_amount, spent_amount,
      currency, categories, schedules, metadata, hold_movement_id,
      period_label, budget_type, summary_line, next_run_at
    ) VALUES (
      $1, $2, $3, 'active', $4, $4, 0, $5, $6::jsonb, $7::jsonb, $8::jsonb, NULL,
      $9, $10, $11, $12
    ) RETURNING *`,
    [
      userId,
      title,
      flowType,
      total,
      currency,
      JSON.stringify(categories),
      JSON.stringify(schedules),
      JSON.stringify(flowMetadata),
      input.periodLabel ?? null,
      input.budgetType ?? 'monthly',
      input.summaryLine ?? null,
      nextRunAt,
    ]
  );

  const linkedSchedules = await linkBudgetsForSchedules(
    userId,
    row.id,
    schedules,
    currency,
    endsAt ? { endsAt } : undefined
  );

  if (linkedSchedules.length > 0) {
    await db.none(
      `UPDATE dayflow_flows SET schedules = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [row.id, JSON.stringify(linkedSchedules)]
    );
  }

  const fresh = await db.one<FlowRow>(
    `SELECT * FROM dayflow_flows WHERE id = $1`,
    [row.id]
  );
  return formatFlow(fresh);
}

/**
 * Cancel a flow and return unused held funds to the NGN wallet.
 */
export async function cancelFlow(userId: string, flowId: string) {
  if (!(await flowsTableReady())) {
    throw new Error('DAYFLOW_FLOWS_TABLE_MISSING');
  }

  const row = await db.oneOrNone<FlowRow>(
    `SELECT * FROM dayflow_flows WHERE user_id = $1 AND id = $2 FOR UPDATE`,
    [userId, flowId]
  );
  if (!row) throw new Error('Flow not found');
  if (row.status === 'cancelled') {
    return formatFlow(row);
  }

  const held = Number(row.held_amount);
  const spent = Number(row.spent_amount);
  const payOnDue = isPayOnDueFlow(row);
  const refund = payOnDue ? 0 : Math.max(0, held - spent);

  let releaseMovementId: string | null = null;

  if (refund > 0) {
    const wallet = await loadNgnWallet(userId);
    if (!wallet) throw new Error('NGN wallet not found');

    const releaseRef = newReference('dayflow-release');
    const { usdAmount } = await convertAmountToUsd(refund, 'NGN');

    const credit = await creditWalletBalance({
      userId,
      walletId: wallet.wallet_id,
      amount: refund,
      currency: 'NGN',
      usdEquivalent: usdAmount,
      source: 'dayflow',
      idempotencyKey: `dayflow-release:${releaseRef}`,
      externalReference: releaseRef,
      metadata: {
        dayflowAction: 'release',
        flowId,
        flowTitle: row.title,
      },
    });
    releaseMovementId = credit.movementId;
  }

  await cancelLinkedBudgets(flowId);

  const updated = await db.one<FlowRow>(
    `UPDATE dayflow_flows SET
      status = 'cancelled',
      cancelled_at = CURRENT_TIMESTAMP,
      release_movement_id = COALESCE($3, release_movement_id),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND user_id = $2
    RETURNING *`,
    [flowId, userId, releaseMovementId]
  );

  return {
    flow: formatFlow(updated),
    refundedAmount: refund,
  };
}

export async function runDueSchedulesForUser(userId: string) {
  if (!(await flowsTableReady())) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      results: [] as Array<Record<string, unknown>>,
    };
  }

  const usdWallet = await loadUsdWallet(userId);
  if (!usdWallet) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      results: [] as Array<Record<string, unknown>>,
    };
  }

  const dueFlows = await db.manyOrNone<FlowRow>(
    `SELECT * FROM dayflow_flows
     WHERE user_id = $1
       AND status = 'active'
       AND next_run_at IS NOT NULL
       AND next_run_at <= CURRENT_TIMESTAMP
     ORDER BY next_run_at ASC`,
    [userId]
  );

  const results: Array<Record<string, unknown>> = [];
  let succeeded = 0;
  let failed = 0;

  for (const flow of dueFlows) {
    const schedules = (Array.isArray(flow.schedules)
      ? flow.schedules
      : []) as DayflowFlowSchedule[];
    let changed = false;
    let flowSpentDelta = 0;
    const payOnDue = isPayOnDueFlow(flow);
    const flowCurrency = String(flow.currency ?? PRIMARY_CURRENCY).toUpperCase();
    const wallet =
      flowCurrency === PRIMARY_CURRENCY
        ? usdWallet
        : await loadNgnWallet(userId);
    const walletBalance = wallet ? Number(wallet.balance) : 0;

    for (const schedule of schedules) {
      if (!schedule?.autoPay) continue;
      const dueAt = parseScheduleNextRunAt(schedule);
      if (!dueAt || dueAt > new Date()) continue;

      const amount = Number(schedule.amount ?? 0);

      if (!Number.isFinite(amount) || amount <= 0) {
        schedule.lastStatus = 'failed';
        schedule.lastError = 'Invalid schedule amount';
        schedule.lastRunAt = new Date().toISOString();
        schedule.runCount = (schedule.runCount ?? 0) + 1;
        changed = true;
        failed += 1;
        results.push({
          flowId: flow.id,
          scheduleId: schedule.id ?? null,
          title: schedule.title,
          status: 'failed',
          error: schedule.lastError,
        });
        continue;
      }

      if (payOnDue) {
        if (walletBalance < amount) {
          schedule.lastStatus = 'failed';
          schedule.lastError = `Insufficient ${flowCurrency} wallet balance for autopay`;
          schedule.lastRunAt = new Date().toISOString();
          schedule.runCount = (schedule.runCount ?? 0) + 1;
          changed = true;
          failed += 1;
          results.push({
            flowId: flow.id,
            scheduleId: schedule.id ?? null,
            title: schedule.title,
            status: 'failed',
            error: schedule.lastError,
          });
          continue;
        }
      } else {
        const remainingInFlow = Math.max(
          0,
          Number(flow.held_amount) - Number(flow.spent_amount) - flowSpentDelta
        );

        if (remainingInFlow < amount) {
          schedule.lastStatus = 'failed';
          schedule.lastError =
            'Insufficient DayFlow held balance for schedule';
          schedule.lastRunAt = new Date().toISOString();
          schedule.runCount = (schedule.runCount ?? 0) + 1;
          changed = true;
          failed += 1;
          results.push({
            flowId: flow.id,
            scheduleId: schedule.id ?? null,
            title: schedule.title,
            status: 'failed',
            error: schedule.lastError,
          });
          continue;
        }
      }

      try {
        if (!wallet) {
          schedule.lastStatus = 'failed';
          schedule.lastError = `${flowCurrency} wallet not found`;
          schedule.lastRunAt = new Date().toISOString();
          schedule.runCount = (schedule.runCount ?? 0) + 1;
          changed = true;
          failed += 1;
          continue;
        }
        await executeSchedulePayment({
          userId,
          walletId: wallet.wallet_id,
          flowId: flow.id,
          flowTitle: flow.title,
          schedule,
          payOnDue,
          flowCurrency,
        });
        const next = computeScheduleNextRunAfterExecution(schedule);
        schedule.nextRunAt = next?.toISOString() ?? null;
        if (!next) {
          schedule.autoPay = false;
        }
        schedule.lastStatus = 'success';
        schedule.lastError = null;
        schedule.lastRunAt = new Date().toISOString();
        schedule.runCount = (schedule.runCount ?? 0) + 1;
        flowSpentDelta += amount;
        changed = true;
        succeeded += 1;
        results.push({
          flowId: flow.id,
          scheduleId: schedule.id ?? null,
          title: schedule.title,
          status: 'success',
          amount,
        });
      } catch (err) {
        schedule.lastStatus = 'failed';
        schedule.lastError = String(err instanceof Error ? err.message : err);
        schedule.lastRunAt = new Date().toISOString();
        schedule.runCount = (schedule.runCount ?? 0) + 1;
        changed = true;
        failed += 1;
        results.push({
          flowId: flow.id,
          scheduleId: schedule.id ?? null,
          title: schedule.title,
          status: 'failed',
          error: schedule.lastError,
        });
      }
    }

    if (!changed) continue;

    const nextRun = earliestNextRun(schedules);
    await db.none(
      `UPDATE dayflow_flows SET
         schedules = $2::jsonb,
         spent_amount = spent_amount + $3,
         next_run_at = $4,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [flow.id, JSON.stringify(schedules), flowSpentDelta, nextRun]
    );
  }

  return {
    processed: succeeded + failed,
    succeeded,
    failed,
    results,
  };
}

export async function runDueSchedulesForAllUsers() {
  if (!(await flowsTableReady())) return { users: 0, processed: 0, succeeded: 0, failed: 0 };
  const rows = await db.manyOrNone<{ user_id: string }>(
    `SELECT DISTINCT user_id
     FROM dayflow_flows
     WHERE status = 'active'
       AND next_run_at IS NOT NULL
       AND next_run_at <= CURRENT_TIMESTAMP`
  );

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const outcome = await runDueSchedulesForUser(row.user_id);
    processed += outcome.processed;
    succeeded += outcome.succeeded;
    failed += outcome.failed;
  }

  return { users: rows.length, processed, succeeded, failed };
}

export type UpdateFlowScheduleInput = Partial<
  Pick<
    DayflowFlowSchedule,
    | 'title'
    | 'amount'
    | 'sourceAmount'
    | 'recipientHint'
    | 'recipientId'
    | 'paymentType'
    | 'execution'
  >
>;

function scheduleKey(schedule: DayflowFlowSchedule): string {
  return String(schedule.id ?? schedule.title);
}

function mergeSchedulePatch(
  current: DayflowFlowSchedule,
  patch: UpdateFlowScheduleInput
): DayflowFlowSchedule {
  const next: DayflowFlowSchedule = { ...current, ...patch };
  if (patch.execution) {
    next.execution = {
      ...current.execution,
      ...patch.execution,
      bill: patch.execution.bill
        ? { ...current.execution?.bill, ...patch.execution.bill }
        : current.execution?.bill,
    };
  }
  return next;
}

export async function updateFlowSchedule(
  userId: string,
  flowId: string,
  scheduleId: string,
  patch: UpdateFlowScheduleInput
) {
  if (!(await flowsTableReady())) {
    throw new Error('DAYFLOW_FLOWS_TABLE_MISSING');
  }

  const row = await db.oneOrNone<FlowRow>(
    `SELECT * FROM dayflow_flows WHERE user_id = $1 AND id = $2 FOR UPDATE`,
    [userId, flowId]
  );
  if (!row) throw new Error('Flow not found');
  if (row.status === 'cancelled') throw new Error('Flow is cancelled');

  const schedules = (
    Array.isArray(row.schedules) ? row.schedules : []
  ) as DayflowFlowSchedule[];

  const idx = schedules.findIndex((s) => scheduleKey(s) === scheduleId);
  if (idx < 0) throw new Error('Schedule not found');

  schedules[idx] = mergeSchedulePatch(schedules[idx], patch);

  const nextRunAt = earliestNextRun(schedules);
  const updated = await db.one<FlowRow>(
    `UPDATE dayflow_flows SET
      schedules = $3::jsonb,
      next_run_at = $4,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND user_id = $2
    RETURNING *`,
    [flowId, userId, JSON.stringify(schedules), nextRunAt]
  );

  return formatFlow(updated);
}

export async function sumActiveHeldAmount(userId: string): Promise<number> {
  if (!(await flowsTableReady())) return 0;
  const row = await db.oneOrNone<{ total: string }>(
    `SELECT COALESCE(SUM(held_amount - spent_amount), 0)::text AS total
     FROM dayflow_flows
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  return row ? Number(row.total) : 0;
}

export async function getFlowsDashboard(userId: string) {
  const flows = await listFlows(userId);
  const heldTotal = flows
    .filter((f) => f.status === 'active')
    .reduce((s, f) => s + f.remainingAmount, 0);

  return {
    flows,
    activeCount: flows.filter((f) => f.status === 'active').length,
    totalHeld: heldTotal,
  };
}
