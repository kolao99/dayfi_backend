import { db } from '../../config/database';
import { ensurePlatformExchangeRates } from './fxService';

const WALLET_CURRENCIES = ['USD', 'NGN', 'GBP', 'EUR'] as const;

let lastSyncAt: Date | null = null;

export function getLastFxSyncAt(): Date | null {
  return lastSyncAt;
}

async function upsertRate(
  base: string,
  target: string,
  rate: number,
  source: string
): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) return;
  await db.none(
    `INSERT INTO exchange_rates (base_currency, target_currency, rate, source, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (base_currency, target_currency)
     DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP`,
    [base, target, rate, source]
  );
}

/**
 * Pull USD-based market rates (open.er-api.com) and upsert wallet pairs.
 * Falls back to platform defaults when the API is unreachable.
 */
export async function syncWalletExchangeRatesFromMarket(): Promise<void> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };
    if (json.result !== 'success' || !json.rates) {
      throw new Error('FX API returned invalid payload');
    }

    const usdRates = json.rates;
    for (const target of WALLET_CURRENCIES) {
      if (target === 'USD') continue;
      const perUsd = usdRates[target];
      if (!perUsd || perUsd <= 0) continue;
      await upsertRate('USD', target, perUsd, 'market');
      await upsertRate(target, 'USD', Number((1 / perUsd).toFixed(8)), 'market');
    }

      for (const a of WALLET_CURRENCIES) {
      if (a === 'USD') continue;
      const aPerUsd = usdRates[a];
      if (!aPerUsd || aPerUsd <= 0) continue;
      for (const b of WALLET_CURRENCIES) {
        if (b === 'USD' || a === b) continue;
        const bPerUsd = usdRates[b];
        if (!bPerUsd || bPerUsd <= 0) continue;
        const cross = Number((bPerUsd / aPerUsd).toFixed(8));
        await upsertRate(a, b, cross, 'market');
      }
    }

    lastSyncAt = new Date();
    console.log(
      `[FX] Wallet rates synced from market at ${lastSyncAt.toISOString()}`
    );
  } catch (err: any) {
    console.warn(
      `[FX] Market sync failed (${err?.message ?? err}); ensuring platform defaults`
    );
    await ensurePlatformExchangeRates();
    lastSyncAt = new Date();
  }
}

export async function getWalletExchangeRateMatrix(): Promise<{
  rates: Record<string, number>;
  updatedAt: string | null;
}> {
  const rows = await db.manyOrNone<{
    base_currency: string;
    target_currency: string;
    rate: string | number;
    updated_at: Date;
  }>(
    `SELECT base_currency, target_currency, rate, updated_at
     FROM exchange_rates
     WHERE base_currency = ANY($1::text[]) AND target_currency = ANY($1::text[])`,
    [WALLET_CURRENCIES]
  );

  const rates: Record<string, number> = {};
  let latest: Date | null = null;
  for (const row of rows ?? []) {
    const key = `${row.base_currency}_${row.target_currency}`;
    rates[key] = Number(row.rate);
    if (row.updated_at && (!latest || row.updated_at > latest)) {
      latest = row.updated_at;
    }
  }

  return {
    rates,
    updatedAt: (latest ?? lastSyncAt)?.toISOString() ?? null,
  };
}

export function startWalletFxSyncScheduler(): void {
  const intervalMs = 30 * 60 * 1000;
  setInterval(() => {
    syncWalletExchangeRatesFromMarket().catch((e) =>
      console.warn('[FX] Scheduled sync failed:', e?.message ?? e)
    );
  }, intervalMs).unref?.();
}
