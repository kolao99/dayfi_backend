import crypto from 'node:crypto';
import { db } from '../../config/database';
import {
  buildIdempotencyKey,
  creditWalletBalance,
  debitWalletBalance,
  newReference,
} from './balanceService';
import {
  buildWalletActivityTxId,
  recordWalletActivity,
} from './walletActivityService';
import { convertAmountToUsd } from './fxService';

const SUPPORTED_CURRENCIES = ['USD'] as const;
export type DayEarnCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export type DayEarnPotRow = {
  id: string;
  user_id: string;
  name: string;
  currency: string;
  principal: string;
  interest_earned: string;
  apy_percent: string;
  accrual_starts_at: Date;
  last_interest_at: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type DayEarnMovementRow = {
  id: string;
  pot_id: string;
  user_id: string;
  movement_type: string;
  amount: string;
  currency: string;
  created_at: Date;
};

function roundMoney(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function roundInterest(n: number): number {
  return roundMoney(n, 4);
}

export function getDayEarnApyPercent(currency: string): number {
  const c = currency.toUpperCase();
  if (c === 'USD') return 7;
  throw new Error(`DayEarn only supports USD (got ${currency})`);
}

export function computeDailyInterest(
  balance: number,
  apyPercent: number
): number {
  if (balance <= 0) return 0;
  return roundInterest((balance * (apyPercent / 100)) / 365);
}

export function computeInterestPreview(amount: number, currency: string) {
  const apy = getDayEarnApyPercent(currency);
  const daily = computeDailyInterest(amount, apy);
  return {
    currency: currency.toUpperCase(),
    apyPercent: apy,
    amount,
    daily,
    monthly: roundMoney(daily * 30),
    yearly: roundMoney(amount * (apy / 100)),
  };
}

/** Next UTC midnight strictly after [at]. */
export function nextUtcMidnightAfter(at: Date): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  if (at.getTime() >= d.getTime()) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function potBalance(row: DayEarnPotRow): number {
  return Number(row.principal) + Number(row.interest_earned);
}

function formatPot(
  row: DayEarnPotRow,
  synced?: DayEarnPotRow,
  interestCreditedToday = 0
) {
  const source = synced ?? row;
  const principal = Number(source.principal);
  const interestEarned = Number(source.interest_earned);
  const balance = principal + interestEarned;
  const apy = Number(source.apy_percent);
  const projectedDailyInterest = computeDailyInterest(balance, apy);
  const accrualStart = new Date(source.accrual_starts_at);
  const lastInterest = source.last_interest_at
    ? new Date(source.last_interest_at)
    : null;
  const nowMs = Date.now();
  const accrualActive = nowMs >= accrualStart.getTime();
  const firstCreditAt = new Date(accrualStart.getTime() + 86400000);
  const awaitingFirstCredit = nowMs < firstCreditAt.getTime();
  const nextInterestAt = lastInterest
    ? new Date(lastInterest.getTime() + 86400000)
    : firstCreditAt;

  return {
    id: source.id,
    name: source.name?.trim() || 'DayEarn',
    currency: source.currency.toUpperCase(),
    principal: roundMoney(principal),
    interestEarned: roundInterest(interestEarned),
    balance: roundMoney(balance),
    apyPercent: apy,
    dailyInterest: projectedDailyInterest,
    projectedDailyInterest,
    todaysInterest: awaitingFirstCredit
      ? 0
      : roundInterest(interestCreditedToday),
    awaitingFirstCredit,
    accrualStartsAt: accrualStart.toISOString(),
    firstCreditAt: firstCreditAt.toISOString(),
    lastInterestAt: lastInterest?.toISOString() ?? null,
    nextInterestAt: nextInterestAt.toISOString(),
    accrualActive,
    status: source.status,
    createdAt: source.created_at.toISOString(),
  };
}

async function sumInterestCreditedTodayUtc(
  userId: string,
  potIds: string[]
): Promise<Map<string, number>> {
  if (potIds.length === 0) return new Map();
  const rows = await db.manyOrNone<{ pot_id: string; total: string }>(
    `SELECT pot_id, COALESCE(SUM(amount::numeric), 0) AS total
     FROM dayearn_movements
     WHERE user_id = $1
       AND pot_id = ANY($2::text[])
       AND movement_type = 'interest'
       AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
     GROUP BY pot_id`,
    [userId, potIds]
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.pot_id, roundInterest(Number(r.total)));
  }
  return map;
}

async function dayEarnTablesReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.dayearn_pots') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

async function getPotRow(
  userId: string,
  potId: string
): Promise<DayEarnPotRow | null> {
  return db.oneOrNone<DayEarnPotRow>(
    `SELECT * FROM dayearn_pots WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [potId, userId]
  );
}

/**
 * Credit one daily interest period per elapsed UTC day since accrual start / last credit.
 */
export async function syncPotInterest(
  userId: string,
  potId: string
): Promise<DayEarnPotRow | null> {
  if (!(await dayEarnTablesReady())) return null;

  return db.tx(async (t) => {
    const row = await t.oneOrNone<DayEarnPotRow>(
      `SELECT * FROM dayearn_pots WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
      [potId, userId]
    );
    if (!row) return null;

    const apy = Number(row.apy_percent);
    let principal = Number(row.principal);
    let interestEarned = Number(row.interest_earned);
    const accrualStart = new Date(row.accrual_starts_at);
    const firstCreditAt = accrualStart.getTime() + 86400000;
    let cursor = row.last_interest_at
      ? new Date(row.last_interest_at)
      : new Date(accrualStart.getTime());
    const now = Date.now();
    const dayMs = 86400000;

    // No interest before one full accrual day after creation (e.g. create May 31 → credit June 2 00:00 UTC).
    if (!row.last_interest_at && now < firstCreditAt) {
      return row;
    }

    let totalNewInterest = 0;
    let credits = 0;

    while (cursor.getTime() + dayMs <= now) {
      const balance = principal + interestEarned + totalNewInterest;
      const daily = computeDailyInterest(balance, apy);
      if (daily > 0) {
        totalNewInterest += daily;
        credits += 1;
        const creditAt = new Date(cursor.getTime() + dayMs);
        const movementId = `dearn-m-${crypto.randomUUID().slice(0, 12)}`;
        await t.none(
          `INSERT INTO dayearn_movements (
             id, pot_id, user_id, movement_type, amount, currency, idempotency_key
           ) VALUES ($1, $2, $3, 'interest', $4, $5, $6)`,
          [
            movementId,
            potId,
            userId,
            daily,
            row.currency,
            `dayearn-interest-${potId}-${creditAt.toISOString().slice(0, 10)}`,
          ]
        );
      }
      cursor = new Date(cursor.getTime() + dayMs);
    }

    if (credits === 0) return row;

    const updated = await t.one<DayEarnPotRow>(
      `UPDATE dayearn_pots
       SET interest_earned = interest_earned + $1,
           last_interest_at = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [totalNewInterest, cursor, potId]
    );
    return updated;
  });
}

async function syncAllPotInterest(userId: string): Promise<void> {
  if (!(await dayEarnTablesReady())) return;
  const pots = await db.manyOrNone<{ id: string }>(
    `SELECT id FROM dayearn_pots WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  for (const pot of pots) {
    await syncPotInterest(userId, pot.id);
  }
}

export async function getDayEarnSummary(userId: string) {
  if (!(await dayEarnTablesReady())) {
    return {
      totalBalance: 0,
      todaysInterest: 0,
      currencyBreakdown: [] as Array<{
        currency: string;
        totalBalance: number;
        todaysInterest: number;
      }>,
      pots: [],
      rates: SUPPORTED_CURRENCIES.map((c) => ({
        currency: c,
        apyPercent: getDayEarnApyPercent(c),
      })),
    };
  }

  await syncAllPotInterest(userId);

  const rows = await db.manyOrNone<DayEarnPotRow>(
    `SELECT * FROM dayearn_pots
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [userId]
  );

  const todayByPot = await sumInterestCreditedTodayUtc(
    userId,
    rows.map((r) => r.id)
  );
  const pots = rows.map((r) =>
    formatPot(r, undefined, todayByPot.get(r.id) ?? 0)
  );
  const byCurrency = new Map<
    string,
    { totalBalance: number; todaysInterest: number }
  >();

  for (const pot of pots) {
    const cur = pot.currency;
    const existing = byCurrency.get(cur) ?? {
      totalBalance: 0,
      todaysInterest: 0,
    };
    existing.totalBalance += pot.balance;
    existing.todaysInterest += pot.todaysInterest;
    byCurrency.set(cur, existing);
  }

  const currencyBreakdown = [...byCurrency.entries()].map(
    ([currency, v]) => ({
      currency,
      totalBalance: roundMoney(v.totalBalance),
      todaysInterest: roundInterest(v.todaysInterest),
    })
  );

  const totalBalance = roundMoney(
    pots.reduce((sum, p) => sum + p.balance, 0)
  );
  const todaysInterest = roundInterest(
    pots.reduce((sum, p) => sum + p.todaysInterest, 0)
  );

  return {
    totalBalance,
    todaysInterest,
    currencyBreakdown,
    pots,
    rates: SUPPORTED_CURRENCIES.map((c) => ({
      currency: c,
      apyPercent: getDayEarnApyPercent(c),
    })),
  };
}

export async function getDayEarnPotDetail(userId: string, potId: string) {
  if (!(await dayEarnTablesReady())) {
    throw new Error('DayEarn is not available yet');
  }

  const synced = await syncPotInterest(userId, potId);
  const row = synced ?? (await getPotRow(userId, potId));
  if (!row) throw new Error('DayEarn pot not found');

  const todayMap = await sumInterestCreditedTodayUtc(userId, [potId]);

  const movements = await db.manyOrNone<DayEarnMovementRow>(
    `SELECT * FROM dayearn_movements
     WHERE pot_id = $1 AND user_id = $2
     ORDER BY created_at DESC
     LIMIT 50`,
    [potId, userId]
  );

  return {
    pot: formatPot(row, undefined, todayMap.get(potId) ?? 0),
    activity: movements.map((m) => ({
      id: m.id,
      type: m.movement_type,
      amount: roundMoney(Number(m.amount), 4),
      currency: m.currency.toUpperCase(),
      createdAt: m.created_at.toISOString(),
    })),
  };
}

export async function createDayEarnPot(params: {
  userId: string;
  walletId: string;
  name: string;
  amount: number;
  currency: string;
  idempotencyKey?: string;
}) {
  if (!(await dayEarnTablesReady())) {
    throw new Error('DayEarn is not available yet');
  }

  const currency = 'USD';
  if (String(params.currency).toUpperCase() !== currency) {
    throw new Error('DayEarn only supports USD');
  }

  const name = String(params.name || '').trim();
  if (!name || name.length > 120) {
    throw new Error('Pot name is required (max 120 characters)');
  }

  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid amount');
  }

  const apy = getDayEarnApyPercent(currency);
  const potId = `dearn-${crypto.randomUUID().slice(0, 12)}`;
  const reference = newReference('dayearn-create');
  const idempotencyKey =
    params.idempotencyKey ?? buildIdempotencyKey('dayearn-create', reference);
  const now = new Date();
  const accrualStartsAt = nextUtcMidnightAfter(now);

  await debitWalletBalance({
    userId: params.userId,
    walletId: params.walletId,
    amount,
    currency,
    source: 'dayearn',
    idempotencyKey: `${idempotencyKey}-debit`,
    externalReference: reference,
    metadata: { potId, potName: name, action: 'create' },
  });

  const pot = await db.tx(async (t) => {
    const inserted = await t.one<DayEarnPotRow>(
      `INSERT INTO dayearn_pots (
         id, user_id, name, currency, principal, apy_percent, accrual_starts_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [potId, params.userId, name, currency, amount, apy, accrualStartsAt]
    );

    await t.none(
      `INSERT INTO dayearn_movements (
         id, pot_id, user_id, movement_type, amount, currency, idempotency_key
       ) VALUES ($1, $2, $3, 'deposit', $4, $5, $6)`,
      [
        `dearn-m-${crypto.randomUUID().slice(0, 12)}`,
        potId,
        params.userId,
        amount,
        currency,
        `${idempotencyKey}-deposit`,
      ]
    );

    return inserted;
  });

  try {
    await recordWalletActivity({
      userId: params.userId,
      id: buildWalletActivityTxId(reference),
      direction: 'debit',
      amount,
      currency,
      source: 'dayearn',
      title: `DayEarn · ${name}`,
      reason: `Added to ${name} DayEarn pot`,
      externalReference: reference,
      channel: 'wallet',
      beneficiaryName: 'DayEarn',
      accountType: 'dayearn',
      accountNumber: name,
    });
  } catch {
    /* non-fatal */
  }

  return {
    pot: formatPot(pot),
    preview: computeInterestPreview(amount, currency),
    accrualNote:
      'Interest counting starts at midnight on the day after you create. Keep funds through that full day — your first credit lands at the next midnight (e.g. create May 31, first interest June 2 at 12:00 AM UTC). Withdraw before then and you earn nothing.',
  };
}

export async function depositToDayEarnPot(params: {
  userId: string;
  walletId: string;
  potId: string;
  amount: number;
  idempotencyKey?: string;
}) {
  if (!(await dayEarnTablesReady())) {
    throw new Error('DayEarn is not available yet');
  }

  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid amount');
  }

  await syncPotInterest(params.userId, params.potId);
  const row = await getPotRow(params.userId, params.potId);
  if (!row) throw new Error('DayEarn pot not found');

  const currency = row.currency.toUpperCase();
  const reference = newReference('dayearn-deposit');
  const idempotencyKey =
    params.idempotencyKey ?? buildIdempotencyKey('dayearn-deposit', reference);

  await debitWalletBalance({
    userId: params.userId,
    walletId: params.walletId,
    amount,
    currency,
    source: 'dayearn',
    idempotencyKey: `${idempotencyKey}-debit`,
    externalReference: reference,
    metadata: { potId: params.potId, action: 'deposit' },
  });

  const updated = await db.tx(async (t) => {
    const pot = await t.one<DayEarnPotRow>(
      `UPDATE dayearn_pots
       SET principal = principal + $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3 AND status = 'active'
       RETURNING *`,
      [amount, params.potId, params.userId]
    );

    await t.none(
      `INSERT INTO dayearn_movements (
         id, pot_id, user_id, movement_type, amount, currency, idempotency_key
       ) VALUES ($1, $2, $3, 'deposit', $4, $5, $6)`,
      [
        `dearn-m-${crypto.randomUUID().slice(0, 12)}`,
        params.potId,
        params.userId,
        amount,
        currency,
        `${idempotencyKey}-deposit`,
      ]
    );

    return pot;
  });

  try {
    await recordWalletActivity({
      userId: params.userId,
      id: buildWalletActivityTxId(reference),
      direction: 'debit',
      amount,
      currency,
      source: 'dayearn',
      title: `DayEarn · ${row.name}`,
      reason: `Added to ${row.name} DayEarn pot`,
      externalReference: reference,
      channel: 'wallet',
      beneficiaryName: 'DayEarn',
      accountType: 'dayearn',
      accountNumber: row.name,
    });
  } catch {
    /* non-fatal */
  }

  return { pot: formatPot(updated) };
}

export async function withdrawFromDayEarnPot(params: {
  userId: string;
  walletId: string;
  potId: string;
  amount?: number;
  withdrawAll?: boolean;
  idempotencyKey?: string;
}) {
  if (!(await dayEarnTablesReady())) {
    throw new Error('DayEarn is not available yet');
  }

  await syncPotInterest(params.userId, params.potId);
  const row = await getPotRow(params.userId, params.potId);
  if (!row) throw new Error('DayEarn pot not found');

  const totalBalance = potBalance(row);
  if (totalBalance <= 0) throw new Error('Nothing to withdraw');

  let withdrawAmount = params.withdrawAll
    ? totalBalance
    : Number(params.amount);
  if (!Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
    throw new Error('Invalid withdrawal amount');
  }
  if (withdrawAmount > totalBalance + 0.0001) {
    throw new Error('Withdrawal amount exceeds pot balance');
  }
  withdrawAmount = roundMoney(Math.min(withdrawAmount, totalBalance));

  const currency = row.currency.toUpperCase();
  const reference = newReference('dayearn-withdraw');
  const idempotencyKey =
    params.idempotencyKey ?? buildIdempotencyKey('dayearn-withdraw', reference);

  let principal = Number(row.principal);
  let interestEarned = Number(row.interest_earned);
  let fromInterest = Math.min(withdrawAmount, interestEarned);
  let fromPrincipal = withdrawAmount - fromInterest;
  interestEarned -= fromInterest;
  principal -= fromPrincipal;

  const closePot = principal <= 0 && interestEarned <= 0;

  await db.tx(async (t) => {
    await t.none(
      `UPDATE dayearn_pots
       SET principal = $1,
           interest_earned = $2,
           status = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [
        Math.max(0, principal),
        Math.max(0, interestEarned),
        closePot ? 'closed' : 'active',
        params.potId,
      ]
    );

    await t.none(
      `INSERT INTO dayearn_movements (
         id, pot_id, user_id, movement_type, amount, currency, idempotency_key
       ) VALUES ($1, $2, $3, 'withdraw', $4, $5, $6)`,
      [
        `dearn-m-${crypto.randomUUID().slice(0, 12)}`,
        params.potId,
        params.userId,
        withdrawAmount,
        currency,
        `${idempotencyKey}-withdraw`,
      ]
    );
  });

  const { usdAmount: usdEq } = await convertAmountToUsd(withdrawAmount, currency);
  await creditWalletBalance({
    userId: params.userId,
    walletId: params.walletId,
    amount: withdrawAmount,
    currency,
    usdEquivalent: usdEq,
    source: 'dayearn',
    idempotencyKey: `${idempotencyKey}-credit`,
    externalReference: reference,
    metadata: {
      potId: params.potId,
      potName: row.name,
      action: 'withdraw',
    },
  });

  const updated = closePot
    ? null
    : await getPotRow(params.userId, params.potId);

  return {
    withdrawn: withdrawAmount,
    currency,
    closed: closePot,
    pot: updated ? formatPot(updated) : null,
  };
}

export async function renameDayEarnPot(
  userId: string,
  potId: string,
  name: string
) {
  if (!(await dayEarnTablesReady())) {
    throw new Error('DayEarn is not available yet');
  }

  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed.length > 120) {
    throw new Error('Pot name is required (max 120 characters)');
  }

  const row = await db.oneOrNone<DayEarnPotRow>(
    `UPDATE dayearn_pots
     SET name = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND user_id = $3 AND status = 'active'
     RETURNING *`,
    [trimmed, potId, userId]
  );
  if (!row) throw new Error('DayEarn pot not found');
  return { pot: formatPot(row) };
}

export { SUPPORTED_CURRENCIES };
