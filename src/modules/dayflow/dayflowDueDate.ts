const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function parseDueLabelToNextRunAt(
  dueLabel: string | undefined | null,
  from: Date = new Date()
): Date | null {
  if (!dueLabel || !String(dueLabel).trim()) return null;
  const lower = String(dueLabel).toLowerCase().trim();

  const iso = new Date(dueLabel.trim());
  if (!Number.isNaN(iso.getTime()) && dueLabel.includes('-')) {
    return iso;
  }

  if (lower.includes('today')) {
    const d = new Date(from);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  if (lower.includes('tomorrow')) {
    const d = new Date(from);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (!lower.includes(name)) continue;
    const cursor = new Date(from);
    cursor.setHours(9, 0, 0, 0);
    for (let i = 0; i < 14; i++) {
      if (cursor.getDay() === weekday) return cursor;
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const monthDay = lower.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/
  );
  if (monthDay) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const monthKey = monthDay[1].slice(0, 3);
    const day = Number(monthDay[2]);
    const month = months[monthKey];
    if (month != null && Number.isFinite(day)) {
      let year = from.getFullYear();
      const candidate = new Date(year, month, day, 9, 0, 0, 0);
      const today = new Date(from);
      today.setHours(0, 0, 0, 0);
      if (candidate < today) year += 1;
      return new Date(year, month, day, 9, 0, 0, 0);
    }
  }

  return null;
}

export function resolveNextRunAtIso(params: {
  dueLabel?: string | null;
  nextRunAt?: string | null;
  frequency?: string;
  from?: Date;
}): string | null {
  const explicit = params.nextRunAt?.trim();
  if (explicit) {
    const d = new Date(explicit);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const freq = String(params.frequency ?? 'monthly').toLowerCase();
  const due = params.dueLabel ?? '';
  const lower = due.toLowerCase();

  if (
    freq === 'once' ||
    lower.includes('tomorrow') ||
    lower.includes('today')
  ) {
    const parsed = parseDueLabelToNextRunAt(due, params.from);
    return parsed?.toISOString() ?? null;
  }

  if (freq === 'weekly' || freq === 'biweekly') {
    const parsed = parseDueLabelToNextRunAt(due, params.from);
    if (parsed) return parsed.toISOString();
  }

  return null;
}

export function hasResolvableSchedule(params: {
  dueLabel?: string | null;
  nextRunAt?: string | null;
  frequency?: string;
}): boolean {
  if (params.nextRunAt && !Number.isNaN(new Date(params.nextRunAt).getTime())) {
    return true;
  }
  const freq = String(params.frequency ?? 'monthly').toLowerCase();
  const due = (params.dueLabel ?? '').trim();
  if (freq === 'monthly' || freq === 'weekly' || freq === 'biweekly' || freq === 'daily') {
    return due.length > 0 || parseDueLabelToNextRunAt(due) != null;
  }
  return parseDueLabelToNextRunAt(due) != null;
}
