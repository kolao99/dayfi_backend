import { db } from '../../config/database';
import {
  debitUsdBalance,
  buildIdempotencyKey,
  newReference,
} from './balanceService';
import { PRIMARY_CURRENCY } from './walletModel';
import { findPlanByLockDays, getStaticMaxApyPercent } from './investmentPlans';
import {
  calculateMaturityInterest,
  getInvestmentPlansForApi,
  getMaxTvlUsd,
  getMaxUserLockedUsd,
  getTotalLockedPrincipalUsd,
  getUserLockedPrincipalUsd,
  getTreasuryStatusForApi,
  resolveApyForDeposit,
} from './investmentTreasuryService';

export type InvestmentPositionRow = {
  id: string;
  user_id: string;
  principal: string;
  apy_percent: string;
  lock_days: number;
  interest_earned: string;
  status: string;
  started_at: Date;
  matures_at: Date;
  claimed_at: Date | null;
  deposit_reference: string;
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatPosition(row: InvestmentPositionRow) {
  const principal = Number(row.principal);
  const apy = Number(row.apy_percent);
  const lockDays = row.lock_days;
  const interest =
    Number(row.interest_earned) > 0
      ? Number(row.interest_earned)
      : calculateMaturityInterest(principal, apy, lockDays);
  const now = Date.now();
  const maturesAt = new Date(row.matures_at);
  const isMatured =
    row.status === 'matured' ||
    row.status === 'claimed' ||
    now >= maturesAt.getTime();
  const canClaim = row.status === 'matured' || (row.status === 'active' && isMatured);

  return {
    id: row.id,
    principal,
    apyPercent: apy,
    lockDays,
    interestEarned: roundMoney(interest),
    totalPayout: roundMoney(principal + interest),
    status: row.status === 'active' && isMatured ? 'matured' : row.status,
    startedAt: row.started_at.toISOString(),
    maturesAt: maturesAt.toISOString(),
    claimedAt: row.claimed_at?.toISOString() ?? null,
    canClaim: canClaim && row.status !== 'claimed',
    daysRemaining: isMatured
      ? 0
      : Math.max(
          0,
          Math.ceil((maturesAt.getTime() - now) / (24 * 60 * 60 * 1000))
        ),
  };
}

async function investmentPositionsReady(): Promise<boolean> {
  const row = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.investment_positions') IS NOT NULL AS exists`
  );
  return row?.exists === true;
}

async function refreshMaturedPositions(userId?: string): Promise<void> {
  if (!(await investmentPositionsReady())) return;
  if (userId) {
    await db.none(
      `UPDATE investment_positions
       SET status = 'matured', updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND status = 'active' AND matures_at <= CURRENT_TIMESTAMP`,
      [userId]
    );
    return;
  }
  await db.none(
    `UPDATE investment_positions
     SET status = 'matured', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'active' AND matures_at <= CURRENT_TIMESTAMP`
  );
}

export async function getInvestmentPlans() {
  const [plans, treasury] = await Promise.all([
    getInvestmentPlansForApi(),
    getTreasuryStatusForApi(),
  ]);
  const maxApy = plans.reduce((m, p) => Math.max(m, p.apyPercent), 0);
  return { plans, treasury, maxApyPercent: maxApy };
}

export async function quoteInvestment(
  amount: number,
  lockDays: number
): Promise<{
  amount: number;
  lockDays: number;
  apyPercent: number;
  estimatedInterest: number;
  estimatedPayout: number;
  maturesAt: string;
}> {
  const tier = findPlanByLockDays(lockDays);
  if (!tier) throw new Error('Invalid lock period');
  if (amount <= 0) throw new Error('Amount must be positive');

  const apyPercent = await resolveApyForDeposit(tier);
  const estimatedInterest = calculateMaturityInterest(
    amount,
    apyPercent,
    lockDays
  );
  const maturesAt = new Date();
  maturesAt.setUTCDate(maturesAt.getUTCDate() + lockDays);

  return {
    amount,
    lockDays,
    apyPercent,
    estimatedInterest: roundMoney(estimatedInterest),
    estimatedPayout: roundMoney(amount + estimatedInterest),
    maturesAt: maturesAt.toISOString(),
  };
}

export async function listInvestmentPositions(userId: string) {
  if (!(await investmentPositionsReady())) return [];
  await refreshMaturedPositions(userId);
  const rows = await db.manyOrNone<InvestmentPositionRow>(
    `SELECT id, user_id, principal, apy_percent, lock_days, interest_earned,
            status, started_at, matures_at, claimed_at, deposit_reference
     FROM investment_positions
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(formatPosition);
}

export async function getInvestmentSummary(userId: string) {
  await refreshMaturedPositions(userId);

  const pocket = await db.oneOrNone<{
    balance: string;
    total_deposited: string;
    risk_accepted_at: Date | null;
  }>(
    `SELECT balance, total_deposited, risk_accepted_at FROM investment_pockets WHERE user_id = $1`,
    [userId]
  );

  const positionsReady = await investmentPositionsReady();
  const agg = positionsReady
    ? await db.one<{
        locked: string;
        pending_interest: string;
        claimable: string;
      }>(
        `SELECT
       COALESCE(SUM(principal) FILTER (WHERE status IN ('active','matured')), 0)::text AS locked,
       COALESCE(SUM(
         CASE WHEN status IN ('active','matured') THEN
           CASE WHEN interest_earned > 0 THEN interest_earned
           ELSE principal * (apy_percent / 100.0) * (lock_days / 365.0)
           END
         ELSE 0 END
       ), 0)::text AS pending_interest,
       COALESCE(SUM(principal) FILTER (WHERE status = 'matured'), 0)::text AS claimable
     FROM investment_positions WHERE user_id = $1`,
        [userId]
      )
    : { locked: '0', pending_interest: '0', claimable: '0' };

  let maxApy = getStaticMaxApyPercent();
  try {
    const plans = await getInvestmentPlansForApi();
    maxApy = plans.reduce((m, p) => Math.max(m, p.apyPercent), 0) || maxApy;
  } catch {
    /* treasury / external rate optional */
  }

  const positions = await listInvestmentPositions(userId);
  const maturedCount = positions.filter((p) => p.canClaim).length;

  return {
    balance: Number(pocket?.balance ?? 0),
    lockedPrincipal: Number(agg.locked),
    estimatedInterest: roundMoney(Number(agg.pending_interest)),
    claimablePrincipal: Number(agg.claimable),
    totalDeposited: Number(pocket?.total_deposited ?? 0),
    riskAccepted: Boolean(pocket?.risk_accepted_at),
    apyDisplayPercent: maxApy,
    currency: PRIMARY_CURRENCY,
    activePositions: positions.filter((p) => p.status === 'active').length,
    maturedReadyToClaim: maturedCount,
    positions,
  };
}

export async function acceptInvestmentRisk(userId: string): Promise<void> {
  await db.none(
    `INSERT INTO investment_pockets (user_id, risk_accepted_at, updated_at)
     VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET risk_accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
    [userId]
  );
}

export async function depositToInvestment(params: {
  userId: string;
  usdWalletId: string;
  amount: number;
  lockDays: number;
  idempotencyKey?: string;
}): Promise<{
  reference: string;
  positionId: string;
  investmentBalance: number;
  apyPercent: number;
  maturesAt: string;
}> {
  if (!(await investmentPositionsReady())) {
    throw new Error(
      'Locked investments are not available yet. Please update the app or try again shortly.'
    );
  }

  const tier = findPlanByLockDays(params.lockDays);
  if (!tier) throw new Error('Invalid lock period. Choose 30, 90, 180, or 365 days.');
  if (params.amount < 1) throw new Error('Minimum investment is $1');

  const pocket = await db.oneOrNone<{ risk_accepted_at: Date | null }>(
    `SELECT risk_accepted_at FROM investment_pockets WHERE user_id = $1`,
    [params.userId]
  );
  if (!pocket?.risk_accepted_at) {
    throw new Error('Accept investment risk disclosure before depositing');
  }

  const [totalLocked, userLocked] = await Promise.all([
    getTotalLockedPrincipalUsd(),
    getUserLockedPrincipalUsd(params.userId),
  ]);
  if (totalLocked + params.amount > getMaxTvlUsd()) {
    throw new Error('Investment pool is at capacity. Try again later.');
  }
  if (userLocked + params.amount > getMaxUserLockedUsd()) {
    throw new Error(
      `Maximum locked investment is $${getMaxUserLockedUsd()} per user`
    );
  }

  const apyPercent = await resolveApyForDeposit(tier);
  const reference = params.idempotencyKey ?? newReference('inv-dep');
  const debitKey = buildIdempotencyKey('investment-debit', reference);
  const positionKey = buildIdempotencyKey('investment-position', reference);

  const existingPos = await db.oneOrNone<{ id: string }>(
    `SELECT id FROM investment_positions WHERE idempotency_key = $1`,
    [positionKey]
  );
  if (existingPos) {
    const summary = await getInvestmentSummary(params.userId);
    const pos = summary.positions.find((p) => p.id === existingPos.id);
    return {
      reference,
      positionId: existingPos.id,
      investmentBalance: summary.balance,
      apyPercent,
      maturesAt: pos?.maturesAt ?? new Date().toISOString(),
    };
  }

  await debitUsdBalance({
    userId: params.userId,
    walletId: params.usdWalletId,
    amountUsd: params.amount,
    source: 'investment',
    idempotencyKey: debitKey,
    externalReference: reference,
    metadata: { direction: 'deposit', lockDays: params.lockDays },
  });

  const maturesAt = new Date();
  maturesAt.setUTCDate(maturesAt.getUTCDate() + params.lockDays);

  const positionId = await db.tx(async (t) => {
    const pos = await t.one<{ id: string }>(
      `INSERT INTO investment_positions (
         user_id, principal, apy_percent, lock_days, status,
         started_at, matures_at, deposit_reference, idempotency_key
       ) VALUES ($1, $2, $3, $4, 'active', CURRENT_TIMESTAMP, $5, $6, $7)
       RETURNING id`,
      [
        params.userId,
        params.amount,
        apyPercent,
        params.lockDays,
        maturesAt,
        reference,
        positionKey,
      ]
    );

    await t.none(
      `INSERT INTO investment_pockets (user_id, balance, total_deposited, updated_at)
       VALUES ($1, $2, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         balance = investment_pockets.balance + EXCLUDED.balance,
         total_deposited = investment_pockets.total_deposited + EXCLUDED.total_deposited,
         updated_at = CURRENT_TIMESTAMP`,
      [params.userId, params.amount]
    );

    const invKey = buildIdempotencyKey('investment-pocket', reference);
    await t.none(
      `INSERT INTO investment_movements (user_id, direction, amount, idempotency_key, position_id)
       VALUES ($1, 'deposit', $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [params.userId, params.amount, invKey, pos.id]
    );

    return pos.id;
  });

  const summary = await getInvestmentSummary(params.userId);
  return {
    reference,
    positionId,
    investmentBalance: summary.balance,
    apyPercent,
    maturesAt: maturesAt.toISOString(),
  };
}

export async function claimInvestmentPosition(params: {
  userId: string;
  usdWalletId: string;
  positionId: string;
  idempotencyKey?: string;
}): Promise<{
  reference: string;
  principal: number;
  interest: number;
  totalPaid: number;
  usdBalance: number;
}> {
  await refreshMaturedPositions(params.userId);

  const reference = params.idempotencyKey ?? newReference('inv-claim');
  const claimKey = buildIdempotencyKey('investment-claim', reference);

  const existing = await db.oneOrNone(
    `SELECT id FROM investment_movements WHERE idempotency_key = $1`,
    [claimKey]
  );
  if (existing) {
    const w = await db.one<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1`,
      [params.usdWalletId]
    );
    return {
      reference,
      principal: 0,
      interest: 0,
      totalPaid: 0,
      usdBalance: Number(w.balance),
    };
  }

  const row = await db.oneOrNone<InvestmentPositionRow>(
    `SELECT id, user_id, principal, apy_percent, lock_days, interest_earned,
            status, started_at, matures_at, claimed_at, deposit_reference
     FROM investment_positions
     WHERE id = $1 AND user_id = $2`,
    [params.positionId, params.userId]
  );
  if (!row) throw new Error('Investment position not found');
  if (row.status === 'claimed') throw new Error('Position already claimed');
  if (new Date(row.matures_at).getTime() > Date.now()) {
    throw new Error('Position has not matured yet');
  }

  const principal = Number(row.principal);
  const apy = Number(row.apy_percent);
  const interest = calculateMaturityInterest(principal, apy, row.lock_days);
  const totalPaid = roundMoney(principal + interest);

  await db.tx(async (t) => {
    const locked = await t.oneOrNone<{ balance: string }>(
      `SELECT balance FROM investment_pockets WHERE user_id = $1 FOR UPDATE`,
      [params.userId]
    );
    if (!locked || Number(locked.balance) < principal) {
      throw new Error('Insufficient investment balance');
    }

    await t.none(
      `UPDATE investment_positions SET
         status = 'claimed',
         interest_earned = $1,
         claimed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status IN ('active', 'matured')`,
      [interest, params.positionId]
    );

    await t.none(
      `UPDATE investment_pockets SET
         balance = balance - $1,
         total_withdrawn = total_withdrawn + $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $3`,
      [principal, totalPaid, params.userId]
    );

    await t.one(
      `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 RETURNING balance`,
      [totalPaid, params.usdWalletId]
    );

    await t.none(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'credit', $3, 'USD', $3, 'investment', $4, $5, $6::jsonb)`,
      [
        params.userId,
        params.usdWalletId,
        totalPaid,
        buildIdempotencyKey('investment-yield-credit', reference),
        reference,
        JSON.stringify({
          direction: 'claim',
          positionId: params.positionId,
          principal,
          interest,
        }),
      ]
    );

    await t.none(
      `INSERT INTO investment_movements (user_id, direction, amount, idempotency_key, position_id)
       VALUES ($1, 'withdraw', $2, $3, $4)`,
      [params.userId, totalPaid, claimKey, params.positionId]
    );
  });

  const w = await db.one<{ balance: string }>(
    `SELECT balance FROM wallets WHERE wallet_id = $1`,
    [params.usdWalletId]
  );

  return {
    reference,
    principal,
    interest: roundMoney(interest),
    totalPaid,
    usdBalance: Number(w.balance),
  };
}

/** Legacy flexible withdraw — blocked when funds are in locked positions. */
export async function withdrawFromInvestment(params: {
  userId: string;
  usdWalletId: string;
  amount: number;
  idempotencyKey?: string;
}): Promise<{ reference: string; usdBalance: number }> {
  const locked = await getUserLockedPrincipalUsd(params.userId);
  const pocket = await db.oneOrNone<{ balance: string }>(
    `SELECT balance FROM investment_pockets WHERE user_id = $1`,
    [params.userId]
  );
  const pocketBal = Number(pocket?.balance ?? 0);
  if (locked > 0 && Math.abs(pocketBal - locked) < 0.01) {
    throw new Error(
      'Funds are locked in investment positions. Claim matured positions instead.'
    );
  }
  throw new Error(
    'Flexible withdrawal is disabled. Claim each matured position from your positions list.'
  );
}
