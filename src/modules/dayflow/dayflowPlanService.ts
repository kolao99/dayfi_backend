import { db } from '../../config/database';

export type DayflowBudgetType = 'weekly' | 'monthly' | 'annual' | 'custom';

export type DayflowCategoryInput = {
  name: string;
  allocated: number;
  spent?: number;
  locked?: boolean;
};

export type DayflowGoalInput = {
  id?: string;
  title: string;
  targetAmount: number;
  savedAmount?: number;
  targetDate?: string;
};

export type DayflowPlanInput = {
  title?: string;
  budgetType?: DayflowBudgetType;
  periodLabel?: string;
  totalBudget: number;
  spent?: number;
  currency?: string;
  summaryLine?: string;
  categories?: DayflowCategoryInput[];
  upcoming?: Record<string, unknown>[];
  goals?: DayflowGoalInput[];
  lockedCategories?: string[];
  sweepToDayEarn?: boolean;
  leftover?: number;
};

type PlanRow = {
  id: string;
  user_id: string;
  title: string;
  budget_type: string;
  period_label: string;
  total_budget: string;
  spent_amount: string;
  currency: string;
  summary_line: string | null;
  categories: unknown;
  upcoming: unknown;
  goals: unknown;
  locked_categories: unknown;
  sweep_to_dayearn: boolean;
  leftover: string;
  status: string;
  starts_at: Date | null;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

async function tableReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.dayflow_plans') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

async function loadNgnBalance(userId: string): Promise<number> {
  const row = await db.oneOrNone<{ balance: string }>(
    `SELECT balance::text AS balance FROM wallets
     WHERE user_id = $1 AND currency = 'NGN' LIMIT 1`,
    [userId]
  );
  return row ? Number(row.balance) : 0;
}

async function loadRecentCategorySpend(userId: string): Promise<
  { category: string; amount: number }[]
> {
  const rows = await db.any<{ reason: string | null; amount: string }>(
    `SELECT wt.reason, wt.send_amount::text AS amount
     FROM wallet_transactions wt
     WHERE wt.user_id = $1
       AND wt.timestamp >= NOW() - INTERVAL '30 days'
       AND wt.send_amount > 0
     ORDER BY wt.timestamp DESC
     LIMIT 50`,
    [userId]
  );
  const buckets = new Map<string, number>();
  for (const r of rows) {
    const key = (r.reason ?? 'Other').trim() || 'Other';
    buckets.set(key, (buckets.get(key) ?? 0) + Number(r.amount));
  }
  return [...buckets.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
}

function formatPlan(row: PlanRow) {
  const categories = Array.isArray(row.categories) ? row.categories : [];
  const upcoming = Array.isArray(row.upcoming) ? row.upcoming : [];
  const goals = Array.isArray(row.goals) ? row.goals : [];
  const lockedCategories = Array.isArray(row.locked_categories)
    ? row.locked_categories
    : [];
  const totalBudget = Number(row.total_budget);
  const spent = Number(row.spent_amount);

  return {
    id: row.id,
    title: row.title,
    budgetType: row.budget_type,
    periodLabel: row.period_label,
    totalBudget,
    spent,
    remaining: Math.max(0, totalBudget - spent),
    currency: row.currency,
    summaryLine: row.summary_line,
    categories,
    upcoming,
    goals,
    lockedCategories,
    sweepToDayEarn: row.sweep_to_dayearn,
    leftover: Number(row.leftover),
    status: row.status,
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function computeHealthScore(plan: ReturnType<typeof formatPlan> | null): number {
  if (!plan) return 62;
  let score = 72;
  const progress =
    plan.totalBudget > 0 ? plan.spent / plan.totalBudget : 0;
  if (progress <= 0.5) score += 12;
  else if (progress <= 0.75) score += 8;
  else if (progress <= 0.9) score += 3;
  else if (progress > 1) score -= 18;
  else score -= 6;

  const cats = plan.categories as DayflowCategoryInput[];
  const overspent = cats.filter(
    (c) => (c.spent ?? 0) > (c.allocated ?? 0) && (c.allocated ?? 0) > 0
  ).length;
  score -= overspent * 8;

  const hasSavings = cats.some((c) =>
    /saving|emergency|invest/i.test(c.name ?? '')
  );
  if (hasSavings) score += 6;

  const goals = plan.goals as DayflowGoalInput[];
  if (goals.length > 0) score += 4;

  return Math.max(35, Math.min(98, Math.round(score)));
}

function computeSafeToSpend(
  ngnBalance: number,
  plan: ReturnType<typeof formatPlan> | null
): number {
  if (!plan) return Math.max(0, ngnBalance);
  const cats = plan.categories as DayflowCategoryInput[];
  const locked = plan.lockedCategories as string[];
  let reserved = 0;
  for (const c of cats) {
    const remaining = Math.max(0, (c.allocated ?? 0) - (c.spent ?? 0));
    if (c.locked || locked.includes(c.name)) {
      reserved += remaining;
    }
  }
  const upcoming = plan.upcoming as { amount?: number }[];
  for (const u of upcoming) {
    reserved += Number(u.amount ?? 0);
  }
  return Math.max(0, Math.min(ngnBalance, ngnBalance - reserved));
}

function computeForecast(
  ngnBalance: number,
  plan: ReturnType<typeof formatPlan> | null
): {
  daysUntilLow: number | null;
  projectedSavings: number;
  message: string;
} {
  if (!plan || plan.totalBudget <= 0) {
    return {
      daysUntilLow: null,
      projectedSavings: 0,
      message: 'Create a plan to unlock cashflow forecasts.',
    };
  }
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0
  ).getDate();
  const daysElapsed = Math.max(1, dayOfMonth);
  const daysLeft = Math.max(1, daysInMonth - dayOfMonth);
  const dailyBurn = plan.spent / daysElapsed;
  const daysUntilLow =
    dailyBurn > 0 ? Math.floor(ngnBalance / dailyBurn) : null;
  const projectedSavings = Math.max(0, plan.remaining);

  let message = `At your current pace, you could save ₦${projectedSavings.toLocaleString('en-NG')} this period.`;
  if (daysUntilLow != null && daysUntilLow < daysLeft) {
    message = `At your current spending rate, your balance may run low in about ${daysUntilLow} days.`;
  }

  return { daysUntilLow, projectedSavings, message };
}

function buildInsights(
  plan: ReturnType<typeof formatPlan> | null,
  recentSpend: { category: string; amount: number }[]
): string[] {
  const insights: string[] = [];
  if (!plan) {
    insights.push('Start a plan so every naira has a purpose before you spend.');
    return insights;
  }

  const cats = plan.categories as DayflowCategoryInput[];
  for (const c of cats) {
    const alloc = c.allocated ?? 0;
    const spent = c.spent ?? 0;
    if (alloc <= 0) continue;
    const pct = Math.round((spent / alloc) * 100);
    if (pct >= 80 && pct < 100) {
      insights.push(`You're nearing your ${c.name} budget (${pct}% used).`);
    }
    if (pct >= 100) {
      insights.push(`${c.name} is over budget — consider adjusting or slowing spend.`);
    }
  }

  if (recentSpend.length > 0) {
    const top = recentSpend[0];
    insights.push(
      `Recent activity shows strong spend on ${top.category} (₦${Math.round(top.amount).toLocaleString('en-NG')} in 30 days).`
    );
  }

  const safeLeft = plan.remaining;
  if (safeLeft > 0 && plan.sweepToDayEarn) {
    insights.push(
      `You have ₦${Math.round(safeLeft).toLocaleString('en-NG')} that could move to DayEarn for yield.`
    );
  }

  if (insights.length === 0) {
    insights.push("You're on track this period — keep it up.");
  }

  return insights.slice(0, 5);
}

export type PendingIncomeEvent = {
  transactionId: string;
  amount: number;
  currency: string;
  channel: string | null;
  reason: string | null;
  timestamp: string;
  label: string;
};

async function incomeAckReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.dayflow_income_ack') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

function depositLabel(
  currency: string,
  channel: string | null,
  reason: string | null
): string {
  const cur = currency.toUpperCase();
  const ch = (channel ?? '').toLowerCase();
  if (ch === 'crypto') return `${cur} crypto top-up`;
  if (ch === 'bank') return `${cur} bank deposit`;
  if (reason?.trim()) return reason.trim();
  return `${cur} wallet top-up`;
}

export async function getPendingIncome(userId: string): Promise<PendingIncomeEvent[]> {
  const ackReady = await incomeAckReady();
  const rows = await db.any<{
    id: string;
    receive_amount: string | null;
    send_amount: string | null;
    ledger_currency: string | null;
    receive_channel: string | null;
    reason: string | null;
    timestamp: Date;
  }>(
    ackReady
      ? `SELECT wt.id, wt.receive_amount::text, wt.send_amount::text,
                wt.ledger_currency, wt.receive_channel, wt.reason, wt.timestamp
         FROM wallet_transactions wt
         LEFT JOIN dayflow_income_ack ack
           ON ack.user_id = wt.user_id AND ack.transaction_id = wt.id
         WHERE wt.user_id = $1
           AND wt.activity_kind = 'deposit'
           AND wt.timestamp >= NOW() - INTERVAL '14 days'
           AND ack.transaction_id IS NULL
         ORDER BY wt.timestamp DESC
         LIMIT 5`
      : `SELECT wt.id, wt.receive_amount::text, wt.send_amount::text,
                wt.ledger_currency, wt.receive_channel, wt.reason, wt.timestamp
         FROM wallet_transactions wt
         WHERE wt.user_id = $1
           AND wt.activity_kind = 'deposit'
           AND wt.timestamp >= NOW() - INTERVAL '14 days'
         ORDER BY wt.timestamp DESC
         LIMIT 5`,
    [userId]
  );

  return rows
    .map((r) => {
      const amount = Number(r.receive_amount ?? r.send_amount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const currency = String(r.ledger_currency ?? 'NGN').toUpperCase();
      const channel = r.receive_channel ? String(r.receive_channel) : null;
      return {
        transactionId: r.id,
        amount,
        currency,
        channel,
        reason: r.reason ? String(r.reason) : null,
        timestamp: r.timestamp.toISOString(),
        label: depositLabel(currency, channel, r.reason),
      };
    })
    .filter((row): row is PendingIncomeEvent => row != null);
}

export async function acknowledgeIncome(
  userId: string,
  transactionIds: string[]
): Promise<void> {
  if (!(await incomeAckReady())) return;
  const ids = transactionIds.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) return;

  for (const transactionId of ids) {
    await db.none(
      `INSERT INTO dayflow_income_ack (user_id, transaction_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, transaction_id) DO NOTHING`,
      [userId, transactionId]
    );
  }
}

export async function getActivePlan(userId: string) {
  if (!(await tableReady())) return null;
  const row = await db.oneOrNone<PlanRow>(
    `SELECT * FROM dayflow_plans
     WHERE user_id = $1 AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [userId]
  );
  return row ? formatPlan(row) : null;
}

export async function upsertActivePlan(userId: string, input: DayflowPlanInput) {
  if (!(await tableReady())) {
    throw new Error('DAYFLOW_PLANS_TABLE_MISSING');
  }

  const existing = await getActivePlan(userId);
  const categories = input.categories ?? [];
  const upcoming = input.upcoming ?? [];
  const goals = input.goals ?? [];
  const lockedCategories = input.lockedCategories ?? [];

  if (existing) {
    const row = await db.one<PlanRow>(
      `UPDATE dayflow_plans SET
        title = $2,
        budget_type = $3,
        period_label = $4,
        total_budget = $5,
        spent_amount = $6,
        currency = $7,
        summary_line = $8,
        categories = $9::jsonb,
        upcoming = $10::jsonb,
        goals = $11::jsonb,
        locked_categories = $12::jsonb,
        sweep_to_dayearn = $13,
        leftover = $14,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
      [
        existing.id,
        input.title ?? existing.title,
        input.budgetType ?? existing.budgetType,
        input.periodLabel ?? existing.periodLabel,
        input.totalBudget,
        input.spent ?? existing.spent,
        input.currency ?? 'NGN',
        input.summaryLine ?? existing.summaryLine,
        JSON.stringify(categories),
        JSON.stringify(upcoming),
        JSON.stringify(goals),
        JSON.stringify(lockedCategories),
        input.sweepToDayEarn ?? existing.sweepToDayEarn,
        input.leftover ?? existing.leftover,
      ]
    );
    return formatPlan(row);
  }

  const row = await db.one<PlanRow>(
    `INSERT INTO dayflow_plans (
      user_id, title, budget_type, period_label, total_budget, spent_amount,
      currency, summary_line, categories, upcoming, goals, locked_categories,
      sweep_to_dayearn, leftover, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
      $12::jsonb, $13, $14, 'active'
    ) RETURNING *`,
    [
      userId,
      input.title ?? 'My Plan',
      input.budgetType ?? 'monthly',
      input.periodLabel ?? 'This Month',
      input.totalBudget,
      input.spent ?? 0,
      input.currency ?? 'NGN',
      input.summaryLine ?? null,
      JSON.stringify(categories),
      JSON.stringify(upcoming),
      JSON.stringify(goals),
      JSON.stringify(lockedCategories),
      input.sweepToDayEarn ?? false,
      input.leftover ?? 0,
    ]
  );
  return formatPlan(row);
}

export async function getDayflowDashboard(userId: string) {
  const [ngnBalance, plan, recentSpend, pendingIncome] = await Promise.all([
    loadNgnBalance(userId),
    getActivePlan(userId),
    loadRecentCategorySpend(userId),
    getPendingIncome(userId),
  ]);

  const safeToSpend = computeSafeToSpend(ngnBalance, plan);
  const healthScore = computeHealthScore(plan);
  const forecast = computeForecast(ngnBalance, plan);
  const insights = buildInsights(plan, recentSpend);

  return {
    ngnBalance,
    safeToSpend,
    healthScore,
    forecast,
    insights,
    recentSpend,
    pendingIncome,
    plan,
    hasActivePlan: plan != null,
  };
}
