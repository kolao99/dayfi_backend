import { runDueSchedulesForAllUsers } from './dayflowFlowService';

let timer: NodeJS.Timeout | null = null;
let running = false;

function intervalMs(): number {
  const raw = Number(process.env.DAYFLOW_AUTOPAY_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(raw) || raw < 10_000) return 60_000;
  return raw;
}

function enabled(): boolean {
  const raw = String(process.env.DAYFLOW_AUTOPAY_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export async function runDayflowAutopayTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const outcome = await runDueSchedulesForAllUsers();
    if (outcome.processed > 0 || outcome.failed > 0) {
      console.log(
        `[dayflow-autopay] users=${outcome.users} processed=${outcome.processed} success=${outcome.succeeded} failed=${outcome.failed}`
      );
    }
  } catch (err) {
    console.warn(
      `[dayflow-autopay] tick failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    running = false;
  }
}

export function startDayflowAutopayScheduler(): void {
  if (!enabled()) {
    console.log('[dayflow-autopay] scheduler disabled via env');
    return;
  }
  if (timer) return;
  const ms = intervalMs();
  timer = setInterval(() => {
    runDayflowAutopayTick();
  }, ms);
  runDayflowAutopayTick();
  console.log(`[dayflow-autopay] scheduler started (${ms}ms interval)`);
}

