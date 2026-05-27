/** Lock tiers — max APY capped by treasury service at runtime. */
export type InvestmentPlanTier = {
  lockDays: number;
  label: string;
  maxApyPercent: number;
};

export const INVESTMENT_PLAN_TIERS: InvestmentPlanTier[] = [
  { lockDays: 30, label: '30 days', maxApyPercent: 4 },
  { lockDays: 90, label: '90 days', maxApyPercent: 6 },
  { lockDays: 180, label: '180 days', maxApyPercent: 8 },
  { lockDays: 365, label: '365 days', maxApyPercent: 10 },
];

/** Extra APY for longer locks (on top of treasury base yield). */
export const LOCK_APY_BONUS: Record<number, number> = {
  30: 0,
  90: 0.5,
  180: 1.0,
  365: 1.5,
};

export function getLockApyBonus(lockDays: number): number {
  return LOCK_APY_BONUS[lockDays] ?? 0;
}

export function findPlanByLockDays(lockDays: number): InvestmentPlanTier | undefined {
  return INVESTMENT_PLAN_TIERS.find((t) => t.lockDays === lockDays);
}

export function getStaticMaxApyPercent(): number {
  return INVESTMENT_PLAN_TIERS.reduce((m, t) => Math.max(m, t.maxApyPercent), 0);
}
