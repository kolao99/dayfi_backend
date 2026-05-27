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

export function findPlanByLockDays(lockDays: number): InvestmentPlanTier | undefined {
  return INVESTMENT_PLAN_TIERS.find((t) => t.lockDays === lockDays);
}

export function getStaticMaxApyPercent(): number {
  return INVESTMENT_PLAN_TIERS.reduce((m, t) => Math.max(m, t.maxApyPercent), 0);
}
