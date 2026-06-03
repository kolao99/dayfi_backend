/**
 * Mirrors mobile `dayflowCategoryNeedsAutopaySchedule` — spending pockets (Food,
 * Sweets, Water) should not become recurring autopay schedules.
 */
export function categoryNeedsAutopaySchedule(name: string): boolean {
  const t = name.toLowerCase().trim();
  if (
    /airtime|data|electric|utility|cable|dstv|gotv|internet|bill/.test(t)
  ) {
    return true;
  }
  if (/family|support|allowance|mom|dad|rent/.test(t)) {
    return true;
  }
  if (/saving|emergency/.test(t)) {
    return true;
  }
  return false;
}

export type ScheduleLike = {
  title?: string;
  recipientHint?: string | null;
  recipientId?: string | null;
  paymentType?: string | null;
};

/** Whether an existing schedule row should remain on a flow. */
export function scheduleShouldKeep(schedule: ScheduleLike): boolean {
  const paymentType = (schedule.paymentType ?? 'send').toLowerCase();
  if (paymentType === 'savings' || paymentType === 'bill') return true;

  const hint = String(schedule.recipientHint ?? '').trim();
  if (hint) return true;

  const recipientId = String(schedule.recipientId ?? '').trim();
  if (recipientId) return true;

  return categoryNeedsAutopaySchedule(String(schedule.title ?? ''));
}
