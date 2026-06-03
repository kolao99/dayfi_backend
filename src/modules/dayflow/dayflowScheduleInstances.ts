import type { DayflowFlowSchedule } from './dayflowFlowService';

export type ScheduleInstanceStatus =
  | 'upcoming'
  | 'paid'
  | 'failed'
  | 'overdue';

export type DayflowScheduleInstance = {
  id: string;
  flowId: string;
  scheduleId: string;
  title: string;
  amount: number;
  dueAt: string;
  status: ScheduleInstanceStatus;
  autoPay: boolean;
  paymentType: string;
  recipientHint?: string | null;
  recipientId?: string | null;
  needsSetup: boolean;
  flowTitle?: string;
  frequency?: string;
  dueLabel?: string | null;
};

type FlowLike = {
  id: string;
  title: string;
  periodLabel?: string | null;
  budgetType?: string | null;
  schedules?: DayflowFlowSchedule[];
  categories?: { name: string; allocated: number }[];
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function currentPeriodBounds(ref: Date = new Date()): {
  start: Date;
  end: Date;
  label: string;
} {
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return {
    start,
    end,
    label: `${months[ref.getMonth()]} ${ref.getFullYear()}`,
  };
}

function parseWeekday(label?: string | null): number | null {
  if (!label) return null;
  const lower = label.toLowerCase();
  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    if (lower.includes(name)) return idx;
  }
  return null;
}

function parseMonthDay(label?: string | null, ref?: Date): number | null {
  if (!label) return null;
  const m = label.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) return day;
  }
  return ref ? ref.getDate() : null;
}

function datesInRange(start: Date, end: Date, stepDays: number): Date[] {
  const out: Date[] = [];
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur <= last) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + stepDays);
  }
  return out;
}

function weekdaysInPeriod(
  periodStart: Date,
  periodEnd: Date,
  weekday: number
): Date[] {
  const out: Date[] = [];
  const cur = startOfDay(periodStart);
  const last = startOfDay(periodEnd);
  while (cur.getDay() !== weekday && cur <= last) {
    cur.setDate(cur.getDate() + 1);
  }
  while (cur <= last) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

function parseDateRange(label?: string | null): { start: Date; end: Date } | null {
  if (!label) return null;
  const m = label.match(
    /([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*(?:[A-Za-z]+\s+)?(\d{1,2})/i
  );
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  const months: Record<string, number> = {
    january: 0,
    jan: 0,
    february: 1,
    feb: 1,
    march: 2,
    mar: 2,
    april: 3,
    apr: 3,
    may: 4,
    june: 5,
    jun: 5,
    july: 6,
    jul: 6,
    august: 7,
    aug: 7,
    september: 8,
    sep: 8,
    sept: 8,
    october: 9,
    oct: 9,
    november: 10,
    nov: 10,
    december: 11,
    dec: 11,
  };
  const month = months[monthName];
  if (month == null) return null;
  const year = new Date().getFullYear();
  const start = new Date(year, month, Number(m[2]));
  const end = new Date(year, month, Number(m[3]), 23, 59, 59, 999);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

function scheduleNeedsSetup(schedule: DayflowFlowSchedule): boolean {
  const paymentType = schedule.paymentType ?? 'send';
  if (paymentType === 'savings') return false;
  if (paymentType === 'bill') {
    const bill = schedule.execution?.bill;
    if (
      bill?.categoryCode &&
      bill?.billerCode &&
      bill?.itemCode &&
      bill?.customerId
    ) {
      return false;
    }
    return !(schedule.recipientHint && String(schedule.recipientHint).trim());
  }
  const tag =
    (schedule.recipientId && String(schedule.recipientId).trim()) ||
    (schedule.recipientHint && String(schedule.recipientHint).trim());
  return !tag;
}

function resolveStatus(
  dueAt: Date,
  schedule: DayflowFlowSchedule,
  now: Date
): ScheduleInstanceStatus {
  const dueStart = startOfDay(dueAt).getTime();
  const todayStart = startOfDay(now).getTime();
  if (dueStart >= todayStart) return 'upcoming';

  const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
  if (lastRun && !Number.isNaN(lastRun.getTime())) {
    const runDay = startOfDay(lastRun).getTime();
    const diffDays = Math.abs(runDay - dueStart) / (24 * 60 * 60 * 1000);
    if (diffDays <= 1 && schedule.lastStatus === 'success') return 'paid';
    if (diffDays <= 1 && schedule.lastStatus === 'failed') return 'failed';
  }

  if (schedule.lastStatus === 'failed') return 'failed';
  return 'overdue';
}

function expandSchedule(
  flow: FlowLike,
  schedule: DayflowFlowSchedule,
  periodStart: Date,
  periodEnd: Date,
  now: Date
): DayflowScheduleInstance[] {
  const freqRaw = String(
    schedule.frequency ?? flow.budgetType ?? 'monthly'
  ).toLowerCase();
  const dueLabel = schedule.dueLabel ?? flow.periodLabel ?? '';
  const scheduleId = schedule.id ?? schedule.title;
  const instances: DayflowScheduleInstance[] = [];

  const base = {
    flowId: flow.id,
    scheduleId,
    title: schedule.title,
    amount: Number(schedule.amount ?? 0),
    autoPay: schedule.autoPay !== false,
    paymentType: schedule.paymentType ?? 'send',
    recipientHint: schedule.recipientHint ?? null,
    recipientId: schedule.recipientId ?? null,
    needsSetup: scheduleNeedsSetup(schedule),
    flowTitle: flow.title,
    frequency: freqRaw,
    dueLabel,
  };

  const range = parseDateRange(dueLabel);
  if (range) {
    instances.push({
      ...base,
      id: `${flow.id}:${scheduleId}:${range.start.toISOString()}`,
      dueAt: range.start.toISOString(),
      status: resolveStatus(range.start, schedule, now),
    });
    return instances;
  }

  if (freqRaw === 'once') {
    const due =
      schedule.nextRunAt != null
        ? new Date(schedule.nextRunAt)
        : periodStart;
    instances.push({
      ...base,
      id: `${flow.id}:${scheduleId}:once`,
      dueAt: due.toISOString(),
      status: resolveStatus(due, schedule, now),
    });
    return instances;
  }

  if (freqRaw === 'daily') {
    for (const day of datesInRange(periodStart, periodEnd, 1)) {
      instances.push({
        ...base,
        id: `${flow.id}:${scheduleId}:${day.toISOString().slice(0, 10)}`,
        dueAt: day.toISOString(),
        status: resolveStatus(day, schedule, now),
      });
    }
    return instances;
  }

  const weekday = parseWeekday(dueLabel);
  if (freqRaw === 'weekly' || weekday != null) {
    const dayIdx = weekday ?? 0;
    for (const day of weekdaysInPeriod(periodStart, periodEnd, dayIdx)) {
      instances.push({
        ...base,
        id: `${flow.id}:${scheduleId}:${day.toISOString().slice(0, 10)}`,
        dueAt: day.toISOString(),
        status: resolveStatus(day, schedule, now),
      });
    }
    return instances;
  }

  if (freqRaw === 'biweekly') {
    const anchor = schedule.nextRunAt
      ? startOfDay(new Date(schedule.nextRunAt))
      : startOfDay(periodStart);
    const cur = new Date(anchor);
    while (cur < periodStart) cur.setDate(cur.getDate() + 14);
    while (cur <= periodEnd) {
      instances.push({
        ...base,
        id: `${flow.id}:${scheduleId}:${cur.toISOString().slice(0, 10)}`,
        dueAt: cur.toISOString(),
        status: resolveStatus(cur, schedule, now),
      });
      cur.setDate(cur.getDate() + 14);
    }
    return instances;
  }

  const dayOfMonth = parseMonthDay(dueLabel, periodStart) ?? 1;
  const due = new Date(
    periodStart.getFullYear(),
    periodStart.getMonth(),
    Math.min(dayOfMonth, periodEnd.getDate())
  );
  instances.push({
    ...base,
    id: `${flow.id}:${scheduleId}:${due.toISOString().slice(0, 10)}`,
    dueAt: due.toISOString(),
    status: resolveStatus(due, schedule, now),
  });
  return instances;
}

function categoryAsSchedule(
  flow: FlowLike,
  cat: { name: string; allocated: number }
): DayflowFlowSchedule {
  return {
    id: `cat-${cat.name}`,
    title: cat.name,
    amount: cat.allocated,
    frequency: (flow.budgetType ?? 'monthly') as import('../payment/budgetService').BudgetFrequency,
    dueLabel: flow.periodLabel ?? undefined,
    autoPay: true,
    paymentType: /airtime|data|electric|bill|dstv|gotv/i.test(cat.name)
      ? 'bill'
      : 'send',
  };
}

export function expandFlowInstances(
  flow: FlowLike,
  periodStart: Date,
  periodEnd: Date,
  now: Date = new Date()
): DayflowScheduleInstance[] {
  const schedules =
    Array.isArray(flow.schedules) && flow.schedules.length > 0
      ? flow.schedules
      : (flow.categories ?? []).map((c) => categoryAsSchedule(flow, c));

  const all: DayflowScheduleInstance[] = [];
  for (const s of schedules) {
    if (!s || Number(s.amount ?? 0) <= 0) continue;
    all.push(...expandSchedule(flow, s, periodStart, periodEnd, now));
  }
  all.sort(
    (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
  );
  return all;
}

export function collectScheduleInstances(params: {
  flows: FlowLike[];
  now?: Date;
}): {
  upcoming: DayflowScheduleInstance[];
  past: DayflowScheduleInstance[];
  committedThisPeriod: number;
  periodLabel: string;
} {
  const now = params.now ?? new Date();
  const { start, end, label } = currentPeriodBounds(now);
  const todayStart = startOfDay(now).getTime();

  const all: DayflowScheduleInstance[] = [];
  for (const flow of params.flows) {
    if (!flow?.id) continue;
    all.push(...expandFlowInstances(flow, start, end, now));
  }

  const upcoming: DayflowScheduleInstance[] = [];
  const past: DayflowScheduleInstance[] = [];

  for (const inst of all) {
    const due = startOfDay(new Date(inst.dueAt)).getTime();
    if (
      inst.status === 'upcoming' ||
      (due >= todayStart && inst.status !== 'paid')
    ) {
      upcoming.push(inst);
    } else {
      past.push(inst);
    }
  }

  upcoming.sort(
    (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
  );
  past.sort(
    (a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime()
  );

  const committedThisPeriod = upcoming.reduce((s, i) => s + i.amount, 0);

  return {
    upcoming,
    past,
    committedThisPeriod,
    periodLabel: label,
  };
}

export function computeFreeToSpend(
  ngnBalance: number,
  committedThisPeriod: number,
  planReserved = 0
): number {
  return Math.max(0, ngnBalance - committedThisPeriod - planReserved);
}
