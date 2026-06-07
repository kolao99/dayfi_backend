import { db } from '../../config/database';

export type BudgetType =
  | 'recurring_send'
  | 'category_spend'
  | 'bill_reminder'
  | 'invest_allocation';

export type BudgetFrequency = 'once' | 'weekly' | 'biweekly' | 'monthly';
export type BudgetStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export type BudgetRow = {
  id: string;
  user_id: string;
  name: string;
  type: string;
  amount: string;
  currency: string;
  frequency: string;
  status: string;
  categories: unknown;
  recipient_id: string | null;
  metadata: unknown;
  spent_amount: string;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function formatBudget(row: BudgetRow) {
  const amount = Number(row.amount);
  const spent = Number(row.spent_amount);
  const categories = Array.isArray(row.categories) ? row.categories : [];
  const metadata =
    row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    amount,
    currency: row.currency,
    frequency: row.frequency,
    status: row.status,
    categories,
    recipientId: row.recipient_id,
    metadata,
    spentAmount: spent,
    remainingAmount: Math.max(0, amount - spent),
    progressPercent:
      amount > 0 ? Math.min(100, Math.round((spent / amount) * 100)) : 0,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function budgetsTableReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.budgets') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

export function computeNextRunAt(
  frequency: BudgetFrequency,
  from: Date = new Date()
): Date | null {
  if (frequency === 'once') return null;
  const d = new Date(from);
  switch (frequency) {
    case 'weekly':
      d.setDate(d.getDate() + 7);
      return d;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      return d;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      return d;
    default:
      return null;
  }
}

export async function listBudgets(userId: string, status?: string) {
  if (!(await budgetsTableReady())) return [];
  const rows = status
    ? await db.manyOrNone<BudgetRow>(
        `SELECT * FROM budgets WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC`,
        [userId, status]
      )
    : await db.manyOrNone<BudgetRow>(
        `SELECT * FROM budgets WHERE user_id = $1 AND status NOT IN ('cancelled') ORDER BY created_at DESC`,
        [userId]
      );
  return (rows ?? []).map(formatBudget);
}

export async function getBudget(userId: string, budgetId: string) {
  if (!(await budgetsTableReady())) return null;
  const row = await db.oneOrNone<BudgetRow>(
    `SELECT * FROM budgets WHERE user_id = $1 AND id = $2`,
    [userId, budgetId]
  );
  return row ? formatBudget(row) : null;
}

export async function createBudget(
  userId: string,
  input: {
    name: string;
    type: BudgetType;
    amount: number;
    currency?: string;
    frequency?: BudgetFrequency;
    categories?: unknown[];
    recipientId?: string | null;
    nextRunAt?: string | Date | null;
    metadata?: Record<string, unknown>;
  }
) {
  if (!(await budgetsTableReady())) {
    throw new Error('Budgets are not available yet. Please try again shortly.');
  }

  const frequency = input.frequency ?? 'monthly';
  let nextRun: Date | null = null;
  if (input.nextRunAt) {
    const parsed = new Date(input.nextRunAt);
    if (!Number.isNaN(parsed.getTime())) nextRun = parsed;
  }
  if (!nextRun) nextRun = computeNextRunAt(frequency);

  const row = await db.one<BudgetRow>(
    `INSERT INTO budgets (
      user_id, name, type, amount, currency, frequency, status,
      categories, recipient_id, metadata, next_run_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8, $9::jsonb, $10)
    RETURNING *`,
    [
      userId,
      input.name.trim(),
      input.type,
      input.amount,
      (input.currency ?? 'USD').toUpperCase(),
      frequency,
      JSON.stringify(input.categories ?? []),
      input.recipientId ?? null,
      JSON.stringify(input.metadata ?? {}),
      nextRun,
    ]
  );

  return formatBudget(row);
}

export async function updateBudget(
  userId: string,
  budgetId: string,
  patch: {
    name?: string;
    amount?: number;
    status?: BudgetStatus;
    categories?: unknown[];
    metadata?: Record<string, unknown>;
    frequency?: BudgetFrequency;
  }
) {
  const existing = await getBudget(userId, budgetId);
  if (!existing) return null;

  const row = await db.one<BudgetRow>(
    `UPDATE budgets SET
      name = COALESCE($3, name),
      amount = COALESCE($4, amount),
      status = COALESCE($5, status),
      categories = COALESCE($6::jsonb, categories),
      metadata = COALESCE($7::jsonb, metadata),
      frequency = COALESCE($8, frequency),
      next_run_at = CASE
        WHEN $5 = 'active' AND status = 'paused' THEN COALESCE(next_run_at, CURRENT_TIMESTAMP + interval '1 day')
        ELSE next_run_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1 AND id = $2
    RETURNING *`,
    [
      userId,
      budgetId,
      patch.name?.trim(),
      patch.amount,
      patch.status,
      patch.categories != null ? JSON.stringify(patch.categories) : null,
      patch.metadata != null ? JSON.stringify(patch.metadata) : null,
      patch.frequency,
    ]
  );

  return formatBudget(row);
}

export async function pauseBudget(userId: string, budgetId: string) {
  return updateBudget(userId, budgetId, { status: 'paused' });
}

export async function resumeBudget(userId: string, budgetId: string) {
  return updateBudget(userId, budgetId, { status: 'active' });
}

export async function deleteBudget(userId: string, budgetId: string) {
  if (!(await budgetsTableReady())) return false;
  const result = await db.result(
    `UPDATE budgets SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND id = $2`,
    [userId, budgetId]
  );
  return result.rowCount > 0;
}
