import { db } from '../../config/database';
import {
  debitUsdBalance,
  buildIdempotencyKey,
  newReference,
} from './balanceService';
import { PRIMARY_CURRENCY } from './walletModel';

const DEFAULT_APY_DISPLAY = 20;

export async function getInvestmentSummary(userId: string) {
  const pocket = await db.oneOrNone<{
    balance: string;
    total_deposited: string;
    risk_accepted_at: Date | null;
  }>(
    `SELECT balance, total_deposited, risk_accepted_at FROM investment_pockets WHERE user_id = $1`,
    [userId]
  );

  return {
    balance: Number(pocket?.balance ?? 0),
    totalDeposited: Number(pocket?.total_deposited ?? 0),
    riskAccepted: Boolean(pocket?.risk_accepted_at),
    apyDisplayPercent: DEFAULT_APY_DISPLAY,
    currency: PRIMARY_CURRENCY,
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
  idempotencyKey?: string;
}): Promise<{ reference: string; investmentBalance: number }> {
  const pocket = await db.oneOrNone<{ risk_accepted_at: Date | null }>(
    `SELECT risk_accepted_at FROM investment_pockets WHERE user_id = $1`,
    [params.userId]
  );
  if (!pocket?.risk_accepted_at) {
    throw new Error('Accept investment risk disclosure before depositing');
  }

  const reference = params.idempotencyKey ?? newReference('inv-dep');
  const debitKey = buildIdempotencyKey('investment-debit', reference);

  await debitUsdBalance({
    userId: params.userId,
    walletId: params.usdWalletId,
    amountUsd: params.amount,
    source: 'investment',
    idempotencyKey: debitKey,
    externalReference: reference,
    metadata: { direction: 'deposit' },
  });

  const invKey = buildIdempotencyKey('investment-pocket', reference);
  const existingInv = await db.oneOrNone(
    `SELECT id FROM investment_movements WHERE idempotency_key = $1`,
    [invKey]
  );

  if (!existingInv) {
    await db.tx(async (t) => {
      await t.none(
        `INSERT INTO investment_pockets (user_id, balance, total_deposited, updated_at)
         VALUES ($1, $2, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
           balance = investment_pockets.balance + EXCLUDED.balance,
           total_deposited = investment_pockets.total_deposited + EXCLUDED.total_deposited,
           updated_at = CURRENT_TIMESTAMP`,
        [params.userId, params.amount]
      );
      await t.none(
        `INSERT INTO investment_movements (user_id, direction, amount, idempotency_key)
         VALUES ($1, 'deposit', $2, $3)`,
        [params.userId, params.amount, invKey]
      );
    });
  }

  const summary = await getInvestmentSummary(params.userId);
  return { reference, investmentBalance: summary.balance };
}

export async function withdrawFromInvestment(params: {
  userId: string;
  usdWalletId: string;
  amount: number;
  idempotencyKey?: string;
}): Promise<{ reference: string; usdBalance: number }> {
  const reference = params.idempotencyKey ?? newReference('inv-wd');
  const invKey = buildIdempotencyKey('investment-withdraw', reference);

  const existing = await db.oneOrNone(
    `SELECT id FROM investment_movements WHERE idempotency_key = $1`,
    [invKey]
  );
  if (existing) {
    const w = await db.one<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1`,
      [params.usdWalletId]
    );
    return { reference, usdBalance: Number(w.balance) };
  }

  await db.tx(async (t) => {
    const pocket = await t.oneOrNone<{ balance: string }>(
      `SELECT balance FROM investment_pockets WHERE user_id = $1 FOR UPDATE`,
      [params.userId]
    );
    if (!pocket || Number(pocket.balance) < params.amount) {
      throw new Error('Insufficient investment balance');
    }

    await t.none(
      `UPDATE investment_pockets SET
         balance = balance - $1,
         total_withdrawn = total_withdrawn + $1,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2`,
      [params.amount, params.userId]
    );

    await t.none(
      `INSERT INTO investment_movements (user_id, direction, amount, idempotency_key)
       VALUES ($1, 'withdraw', $2, $3)`,
      [params.userId, params.amount, invKey]
    );

    await t.one(
      `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 RETURNING balance`,
      [params.amount, params.usdWalletId]
    );

    await t.none(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'credit', $3, 'USD', $3, 'investment', $4, $5, '{"direction":"withdraw"}'::jsonb)`,
      [
        params.userId,
        params.usdWalletId,
        params.amount,
        buildIdempotencyKey('investment-credit', reference),
        reference,
      ]
    );
  });

  const w = await db.one<{ balance: string }>(
    `SELECT balance FROM wallets WHERE wallet_id = $1`,
    [params.usdWalletId]
  );
  return { reference, usdBalance: Number(w.balance) };
}
