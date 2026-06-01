import crypto from 'node:crypto';
import { db } from '../../config/database';
import {
  buildWalletActivityTxId,
  recordWalletActivity,
} from '../payment/walletActivityService';
import {
  creditWalletBalance,
  debitWalletBalance,
  newReference,
} from '../payment/balanceService';
import { convertAmountToUsd } from '../payment/fxService';
import { createBudget, computeNextRunAt } from '../payment/budgetService';
import type { BudgetFrequency } from '../payment/budgetService';
import {
  buildSmartFlowTitle,
  inferFlowType,
  type NamingInput,
} from './dayflowFlowNaming';

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
  frequency?: BudgetFrequency;
  dueLabel?: string;
  recipientHint?: string;
  recipientId?: string | null;
  paymentType?: 'send' | 'bill' | 'savings';
  autoPay?: boolean;
  budgetId?: string | null;
  nextRunAt?: string | null;
};

export type CreateFlowInput = {
  title?: string;
  periodLabel?: string;
  budgetType?: string;
  categories?: DayflowFlowCategory[];
  schedules?: DayflowFlowSchedule[];
  currency?: string;
  summaryLine?: string;
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
    const freq = s.frequency ?? 'monthly';
    const next = computeNextRunAt(freq);
    if (!next) continue;
    if (!earliest || next < earliest) earliest = next;
  }
  return earliest;
}

async function linkBudgetsForSchedules(
  userId: string,
  flowId: string,
  schedules: DayflowFlowSchedule[]
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
        currency: 'NGN',
        frequency: freq,
        recipientId: copy.recipientId ?? null,
        metadata: {
          dayflowFlowId: flowId,
          scheduleId: copy.id,
          recipientHint: copy.recipientHint,
          paymentType: copy.paymentType ?? 'send',
        },
      });
      copy.budgetId = budget.id;
      copy.nextRunAt = budget.nextRunAt;
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
 * Create a flow: debit NGN wallet for the full envelope, optionally link recurring budgets.
 */
export async function createAndActivateFlow(
  userId: string,
  input: CreateFlowInput
) {
  if (!(await flowsTableReady())) {
    throw new Error('DAYFLOW_FLOWS_TABLE_MISSING');
  }

  const categories = input.categories ?? [];
  const schedules = (input.schedules ?? []).map((s) => ({
    ...s,
    id: s.id ?? crypto.randomUUID(),
  }));

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
  const currency = (input.currency ?? 'NGN').toUpperCase();

  if (currency !== 'NGN') {
    throw new Error('DayFlow envelopes currently support NGN only');
  }

  const wallet = await loadNgnWallet(userId);
  if (!wallet) {
    throw new Error('NGN wallet not found');
  }
  if (Number(wallet.balance) < total) {
    throw new Error(
      `Insufficient NGN balance. You need ₦${total.toLocaleString('en-NG')} but have ₦${Number(wallet.balance).toLocaleString('en-NG')}.`
    );
  }

  const flowRef = newReference('dayflow-hold');
  const debit = await debitWalletBalance({
    userId,
    walletId: wallet.wallet_id,
    amount: total,
    currency: 'NGN',
    source: 'dayflow',
    idempotencyKey: `dayflow-hold:${flowRef}`,
    externalReference: flowRef,
    metadata: {
      dayflowAction: 'hold',
      flowTitle: title,
      flowType,
    },
  });

  try {
    await recordWalletActivity({
      userId,
      id: buildWalletActivityTxId(flowRef),
      direction: 'debit',
      amount: total,
      currency: 'NGN',
      source: 'dayflow',
      title: `DayFlow · ${title}`,
      reason: `Set aside for ${title}`,
      externalReference: flowRef,
      channel: 'wallet',
      beneficiaryName: 'DayFlow',
      accountType: 'dayflow',
      accountNumber: title,
    });
  } catch {
    /* non-fatal */
  }

  const nextRunAt = earliestNextRun(schedules);

  const row = await db.one<FlowRow>(
    `INSERT INTO dayflow_flows (
      user_id, title, flow_type, status, total_amount, held_amount, spent_amount,
      currency, categories, schedules, metadata, hold_movement_id,
      period_label, budget_type, summary_line, next_run_at
    ) VALUES (
      $1, $2, $3, 'active', $4, $4, 0, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9,
      $10, $11, $12, $13
    ) RETURNING *`,
    [
      userId,
      title,
      flowType,
      total,
      currency,
      JSON.stringify(categories),
      JSON.stringify(schedules),
      JSON.stringify({ holdRef: flowRef }),
      debit.movementId,
      input.periodLabel ?? null,
      input.budgetType ?? 'monthly',
      input.summaryLine ?? null,
      nextRunAt,
    ]
  );

  const linkedSchedules = await linkBudgetsForSchedules(
    userId,
    row.id,
    schedules
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
  const refund = Math.max(0, held - spent);

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
