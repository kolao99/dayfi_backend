import axios from 'axios';
import { db } from '../../config/database';
import {
  INVESTMENT_PLAN_TIERS,
  type InvestmentPlanTier,
} from './investmentPlans';

const CACHE_MS = 60 * 60 * 1000;
let marketApyCache: { apy: number; at: number } | null = null;

function envNum(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** On-chain / market base yield (USDC lending). Override with INVEST_BASE_APY_PERCENT. */
export async function getTreasuryBaseApyPercent(): Promise<number> {
  const forced = envNum('INVEST_BASE_APY_PERCENT', -1);
  if (forced >= 0) return forced;

  if (marketApyCache && Date.now() - marketApyCache.at < CACHE_MS) {
    return marketApyCache.apy;
  }

  try {
    const res = await axios.get('https://yields.llama.fi/pools', {
      timeout: 8000,
    });
    const pools = (res.data?.data ?? res.data) as Array<{
      symbol?: string;
      chain?: string;
      project?: string;
      apy?: number;
    }>;
    const usdcBase = pools
      .filter(
        (p) =>
          String(p.symbol || '').toUpperCase() === 'USDC' &&
          String(p.chain || '').toLowerCase() === 'base' &&
          String(p.project || '').toLowerCase().includes('aave')
      )
      .map((p) => Number(p.apy))
      .filter((a) => Number.isFinite(a) && a > 0);
    if (usdcBase.length > 0) {
      const best = Math.max(...usdcBase);
      marketApyCache = { apy: Math.round(best * 100) / 100, at: Date.now() };
      return marketApyCache.apy;
    }
  } catch {
    /* use default */
  }

  const fallback = envNum('INVEST_BASE_APY_DEFAULT', 5.5);
  marketApyCache = { apy: fallback, at: Date.now() };
  return fallback;
}

export function getSubsidyApyPercent(): number {
  return envNum('INVEST_SUBSIDY_APY_PERCENT', 0.5);
}

export async function getEffectiveApyPercent(
  tierMaxApy: number
): Promise<number> {
  const base = await getTreasuryBaseApyPercent();
  const ceiling = base + getSubsidyApyPercent();
  return Math.min(tierMaxApy, Math.round(ceiling * 1000) / 1000);
}

export async function getInvestmentPlansForApi(): Promise<
  Array<{
    lockDays: number;
    label: string;
    maxApyPercent: number;
    apyPercent: number;
  }>
> {
  const base = await getTreasuryBaseApyPercent();
  const subsidy = getSubsidyApyPercent();
  return Promise.all(
    INVESTMENT_PLAN_TIERS.map(async (tier) => ({
      lockDays: tier.lockDays,
      label: tier.label,
      maxApyPercent: tier.maxApyPercent,
      apyPercent: await getEffectiveApyPercent(tier.maxApyPercent),
    }))
  ).then((plans) =>
    plans.map((p) => ({
      ...p,
      treasuryBaseApyPercent: base,
      subsidyApyPercent: subsidy,
    }))
  );
}

export function getMaxTvlUsd(): number {
  return envNum('INVEST_MAX_TVL_USD', 100_000);
}

export function getMaxUserLockedUsd(): number {
  return envNum('INVEST_MAX_USER_USD', 10_000);
}

async function investmentPositionsReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.investment_positions') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

export async function getTotalLockedPrincipalUsd(): Promise<number> {
  if (!(await investmentPositionsReady())) return 0;
  const row = await db.oneOrNone<{ total: string }>(
    `SELECT COALESCE(SUM(principal), 0)::text AS total
     FROM investment_positions
     WHERE status IN ('active', 'matured')`
  );
  return Number(row?.total ?? 0);
}

export async function getUserLockedPrincipalUsd(userId: string): Promise<number> {
  if (!(await investmentPositionsReady())) return 0;
  const row = await db.oneOrNone<{ total: string }>(
    `SELECT COALESCE(SUM(principal), 0)::text AS total
     FROM investment_positions
     WHERE user_id = $1 AND status IN ('active', 'matured')`,
    [userId]
  );
  return Number(row?.total ?? 0);
}

export async function getTreasuryStatusForApi(): Promise<{
  baseApyPercent: number;
  subsidyApyPercent: number;
  totalLockedUsd: number;
  maxTvlUsd: number;
}> {
  const [baseApyPercent, totalLockedUsd] = await Promise.all([
    getTreasuryBaseApyPercent(),
    getTotalLockedPrincipalUsd(),
  ]);
  return {
    baseApyPercent,
    subsidyApyPercent: getSubsidyApyPercent(),
    totalLockedUsd,
    maxTvlUsd: getMaxTvlUsd(),
  };
}

export function calculateMaturityInterest(
  principal: number,
  apyPercent: number,
  lockDays: number
): number {
  const interest = principal * (apyPercent / 100) * (lockDays / 365);
  return Math.round(interest * 10000) / 10000;
}

export async function resolveApyForDeposit(
  tier: InvestmentPlanTier
): Promise<number> {
  return getEffectiveApyPercent(tier.maxApyPercent);
}
