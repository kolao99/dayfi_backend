import { runDueBudgetReminders } from './budgetReminderService';

let timer: NodeJS.Timeout | null = null;
let running = false;

function intervalMs(): number {
  const raw = Number(process.env.BUDGET_REMINDER_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(raw) || raw < 10_000) return 60_000;
  return raw;
}

function enabled(): boolean {
  const raw = String(process.env.BUDGET_REMINDER_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export async function runBudgetReminderTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const outcome = await runDueBudgetReminders();
    if (outcome.processed > 0 || outcome.failed > 0) {
      console.log(
        `[budget-reminder] processed=${outcome.processed} failed=${outcome.failed}`
      );
    }
  } catch (err) {
    console.warn(
      `[budget-reminder] tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    running = false;
  }
}

export function startBudgetReminderScheduler(): void {
  if (!enabled()) {
    console.log('[budget-reminder] scheduler disabled via env');
    return;
  }
  if (timer) return;
  const ms = intervalMs();
  timer = setInterval(() => {
    runBudgetReminderTick();
  }, ms);
  runBudgetReminderTick();
  console.log(`[budget-reminder] scheduler started (${ms}ms interval)`);
}
