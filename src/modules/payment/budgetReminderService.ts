import { db } from '../../config/database';
import {
  computeNextRunAt,
  type BudgetFrequency,
  type BudgetRow,
} from './budgetService';
import {
  createUserNotification,
  formatNotificationAmount,
} from '../notifications/notificationService';

async function budgetsTableReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.budgets') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

function parseMetadata(row: BudgetRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function buildReminderCopy(row: BudgetRow): {
  title: string;
  message: string;
  type: string;
} {
  const meta = parseMetadata(row);
  const amount = Number(row.amount);
  const formatted = formatNotificationAmount(amount, row.currency);
  const once = row.frequency === 'once' || meta.reminder === true;

  switch (row.type) {
    case 'bill_reminder': {
      const biller = String(meta.billerName ?? row.name);
      return {
        title: once ? 'Bill reminder' : 'Bill payment due',
        message: once
          ? `Reminder to pay ${biller} (${formatted}). Open Pay bills when ready.`
          : `Your ${row.name} budget is due — pay ${formatted} to ${biller}.`,
        type: 'BUDGET_BILL_REMINDER',
      };
    }
    case 'recurring_send': {
      const recipient = meta.recipientName
        ? ` to ${String(meta.recipientName)}`
        : '';
      return {
        title: once ? 'Send reminder' : 'Scheduled send due',
        message: once
          ? `Reminder to send ${formatted}${recipient}. Open Send to complete.`
          : `Time to send ${formatted}${recipient} for ${row.name}.`,
        type: 'BUDGET_SEND_REMINDER',
      };
    }
    case 'invest_allocation': {
      const pot = String(meta.potName ?? 'your Daily Earn pot');
      return {
        title: 'Daily Earn deposit due',
        message: `Add ${formatted} to ${pot} for ${row.name}.`,
        type: 'BUDGET_DAILY_EARN_REMINDER',
      };
    }
    case 'category_spend': {
      const cats = Array.isArray(row.categories) ? row.categories : [];
      const first = cats[0] as { name?: string } | undefined;
      const category = String(meta.categoryName ?? first?.name ?? 'spending');
      return {
        title: 'Spending cap check-in',
        message: `Review your ${category} budget (${formatted} this period).`,
        type: 'BUDGET_SPENDING_CAP_REMINDER',
      };
    }
    default:
      return {
        title: 'Budget reminder',
        message: `${row.name} is due today.`,
        type: 'BUDGET_REMINDER',
      };
  }
}

async function advanceBudgetAfterReminder(row: BudgetRow): Promise<void> {
  const frequency = row.frequency as BudgetFrequency;
  const meta = parseMetadata(row);
  const endsAtRaw = meta.endsAt;
  const endsAt =
    typeof endsAtRaw === 'string' ? new Date(endsAtRaw) : null;

  if (frequency === 'once') {
    await db.none(
      `UPDATE budgets
       SET status = 'completed', next_run_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [row.id]
    );
    return;
  }

  const from = row.next_run_at ?? new Date();
  const next = computeNextRunAt(frequency, from);

  if (
    !next ||
    (endsAt &&
      !Number.isNaN(endsAt.getTime()) &&
      next.getTime() > endsAt.getTime())
  ) {
    await db.none(
      `UPDATE budgets
       SET status = 'completed', next_run_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [row.id]
    );
    return;
  }

  if (row.type === 'category_spend') {
    await db.none(
      `UPDATE budgets
       SET next_run_at = $2, spent_amount = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [row.id, next]
    );
    return;
  }

  await db.none(
    `UPDATE budgets
     SET next_run_at = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [row.id, next]
  );
}

export type BudgetReminderRunOutcome = {
  processed: number;
  failed: number;
};

export async function runDueBudgetReminders(): Promise<BudgetReminderRunOutcome> {
  if (!(await budgetsTableReady())) {
    return { processed: 0, failed: 0 };
  }

  const dueRows = await db.manyOrNone<BudgetRow>(
    `SELECT * FROM budgets
     WHERE status = 'active'
       AND next_run_at IS NOT NULL
       AND next_run_at <= CURRENT_TIMESTAMP
     ORDER BY next_run_at ASC
     LIMIT 200`
  );

  let processed = 0;
  let failed = 0;

  for (const row of dueRows ?? []) {
    try {
      const copy = buildReminderCopy(row);
      const meta = parseMetadata(row);

      await createUserNotification({
        userId: row.user_id,
        title: copy.title,
        message: copy.message,
        type: copy.type,
        metadata: {
          type: copy.type,
          action: 'open_budget',
          budgetId: row.id,
          budgetType: row.type,
          budgetName: row.name,
          amount: Number(row.amount),
          currency: row.currency,
          frequency: row.frequency,
          ...meta,
        },
      });

      await advanceBudgetAfterReminder(row);
      processed += 1;
    } catch (err: unknown) {
      failed += 1;
      console.warn(
        `[budget-reminder] budget ${row.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return { processed, failed };
}
