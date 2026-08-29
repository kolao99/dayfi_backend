import { db } from '../../config/database';
import {
  buildCorridorDestinations,
  type CorridorDestination,
} from '../infra/infraCorridors';
import YellowCardService from './yellowCardService';

const STALE_MS = 24 * 60 * 60 * 1000;

let lastSyncAttemptAt: Date | null = null;
let syncInFlight: Promise<void> | null = null;

export type PublicCorridorRateRow = {
  countryCode: string;
  name: string;
  currency: string;
  flag: string;
  methods: Array<'bank' | 'momo'>;
  buy: number | null;
  sell: number | null;
  usdPerUnit: number | null;
  updatedAt: string | null;
};

export type PublicRatesPayload = {
  source: string;
  base: 'USD';
  updatedAt: string | null;
  corridors: PublicCorridorRateRow[];
  stablecoins: Array<{
    code: string;
    name: string;
    buy: number;
    sell: number;
    updatedAt: string | null;
  }>;
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRateObject(raw: Record<string, unknown>): {
  buy: number | null;
  sell: number | null;
  updatedAt: string | null;
} {
  const buy = num(raw.buy ?? raw.buyRate);
  const sell = num(raw.sell ?? raw.sellRate);
  const updatedAt =
    typeof raw.updatedAt === 'string'
      ? raw.updatedAt
      : typeof raw.updated_at === 'string'
        ? raw.updated_at
        : null;
  return { buy, sell, updatedAt };
}

export function parseYellowCardRatesPayload(raw: unknown): {
  buy: number | null;
  sell: number | null;
  updatedAt: string | null;
} {
  if (raw == null) return { buy: null, sell: null, updatedAt: null };

  if (Array.isArray(raw)) {
    const first = raw.find((x) => x && typeof x === 'object') as
      | Record<string, unknown>
      | undefined;
    return first ? parseRateObject(first) : { buy: null, sell: null, updatedAt: null };
  }

  if (typeof raw !== 'object') return { buy: null, sell: null, updatedAt: null };
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.rates)) {
    const first = obj.rates.find((x) => x && typeof x === 'object') as
      | Record<string, unknown>
      | undefined;
    return first ? parseRateObject(first) : { buy: null, sell: null, updatedAt: null };
  }

  return parseRateObject(obj);
}

async function upsertPair(
  base: string,
  target: string,
  rate: number,
  source: string
): Promise<void> {
  await db.none(
    `INSERT INTO exchange_rates (base_currency, target_currency, rate, source, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (base_currency, target_currency)
     DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP`,
    [base, target, rate, source]
  );
}

async function readPair(base: string, target: string): Promise<{
  rate: number | null;
  updatedAt: Date | null;
  source: string | null;
}> {
  const row = await db.oneOrNone<{
    rate: string | number;
    updated_at: Date;
    source: string;
  }>(
    `SELECT rate, updated_at, source
     FROM exchange_rates
     WHERE base_currency = $1 AND target_currency = $2`,
    [base, target]
  );
  if (!row) return { rate: null, updatedAt: null, source: null };
  return {
    rate: num(row.rate),
    updatedAt: row.updated_at ?? null,
    source: row.source ?? null,
  };
}

export async function syncYellowCardPublicRates(): Promise<void> {
  const yc = new YellowCardService();
  const corridors = buildCorridorDestinations();
  const currencies = [...new Set(corridors.map((c) => c.currency))];

  if (!yc.isConfigured()) {
    console.warn('[public-rates] Yellow Card not configured — keeping cached/platform rates');
    lastSyncAttemptAt = new Date();
    return;
  }

  await Promise.all(
    currencies.map(async (currency) => {
      try {
        const raw = await yc.fetchExchangeRates(currency);
        const { buy, sell } = parseYellowCardRatesPayload(raw);
        if (buy) await upsertPair('USD', currency, buy, 'yellowcard');
        if (sell) await upsertPair(currency, 'USD', Number((1 / sell).toFixed(10)), 'yellowcard');
      } catch (err: unknown) {
        console.warn(
          `[public-rates] YC fetch failed for ${currency}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    })
  );

  await upsertPair('USD', 'USDC', 1, 'platform');
  await upsertPair('USDC', 'USD', 1, 'platform');

  lastSyncAttemptAt = new Date();
  console.log(`[public-rates] Synced ${currencies.length} corridor currencies at ${lastSyncAttemptAt.toISOString()}`);
}

export function startYellowCardPublicRatesScheduler(): void {
  const dayMs = 24 * 60 * 60 * 1000;
  const tick = () => {
    syncYellowCardPublicRates().catch((err) =>
      console.warn('[public-rates] Scheduled sync failed:', err?.message ?? err)
    );
  };
  tick();
  setInterval(tick, dayMs).unref?.();
}

async function ensureFreshRates(): Promise<void> {
  const latest = await db.oneOrNone<{ updated_at: Date }>(
    `SELECT MAX(updated_at) AS updated_at
     FROM exchange_rates
     WHERE source = 'yellowcard'`
  );
  const stale =
    !latest?.updated_at ||
    Date.now() - new Date(latest.updated_at).getTime() > STALE_MS;

  if (!stale && lastSyncAttemptAt) return;

  if (syncInFlight) {
    await syncInFlight;
    return;
  }

  syncInFlight = syncYellowCardPublicRates().finally(() => {
    syncInFlight = null;
  });
  await syncInFlight;
}

function rowFromCorridor(
  corridor: CorridorDestination,
  buyRow: Awaited<ReturnType<typeof readPair>>,
  sellRow: Awaited<ReturnType<typeof readPair>>
): PublicCorridorRateRow {
  const updatedAt = [buyRow.updatedAt, sellRow.updatedAt]
    .filter(Boolean)
    .sort((a, b) => b!.getTime() - a!.getTime())[0];

  return {
    countryCode: corridor.countryCode,
    name: corridor.name,
    currency: corridor.currency,
    flag: corridor.flag,
    methods: corridor.methods,
    buy: buyRow.rate,
    sell: sellRow.rate,
    usdPerUnit: sellRow.rate,
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

export async function getPublicCorridorRates(): Promise<PublicRatesPayload> {
  await ensureFreshRates();

  const corridors = buildCorridorDestinations();
  const rows: PublicCorridorRateRow[] = [];

  let latest: Date | null = null;
  let source = 'yellowcard';

  for (const corridor of corridors) {
    const buyRow = await readPair('USD', corridor.currency);
    const sellRow = await readPair(corridor.currency, 'USD');
    if (buyRow.source && buyRow.source !== 'yellowcard') source = buyRow.source;
    if (sellRow.source && sellRow.source !== 'yellowcard') source = sellRow.source;

    const row = rowFromCorridor(corridor, buyRow, sellRow);
    rows.push(row);

    for (const d of [buyRow.updatedAt, sellRow.updatedAt]) {
      if (d && (!latest || d > latest)) latest = d;
    }
  }

  const usdcBuy = await readPair('USD', 'USDC');
  const usdcSell = await readPair('USDC', 'USD');

  return {
    source,
    base: 'USD',
    updatedAt: latest?.toISOString() ?? lastSyncAttemptAt?.toISOString() ?? null,
    corridors: rows,
    stablecoins: [
      {
        code: 'USDC',
        name: 'USD Coin',
        buy: usdcBuy.rate ?? 1,
        sell: usdcSell.rate ?? 1,
        updatedAt: usdcBuy.updatedAt?.toISOString() ?? null,
      },
    ],
  };
}
