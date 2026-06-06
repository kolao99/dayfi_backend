import { db } from '../../config/database';

export type FeatureActivityFlags = {
  send: boolean;
  add: boolean;
  swap: boolean;
  pay: boolean;
  invest: boolean;
  budget: boolean;
};

type ActivityRow = {
  send: boolean;
  add: boolean;
  swap: boolean;
  pay: boolean;
  invest: boolean;
  budget_tx: boolean;
};

/**
 * Whether the user has completed at least one money-moving action per home feature.
 * Used by mobile to decide whether to show feature intro screens.
 */
export async function getUserFeatureActivity(
  userId: string
): Promise<FeatureActivityFlags> {
  const row = await db.oneOrNone<ActivityRow>(
    `
    SELECT
      EXISTS (
        SELECT 1
        FROM wallet_transactions wt
        LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
        WHERE wt.user_id = $1
          AND wt.status = 'success-payment'
          AND COALESCE(wt.send_amount, 0) > 0
          AND COALESCE(b.name, '') NOT ILIKE '%currency conversion%'
          AND COALESCE(b.name, '') NOT ILIKE '%bill payment%'
          AND COALESCE(b.name, '') NOT ILIKE '%investment pocket%'
          AND COALESCE(wt.reason, '') NOT ILIKE '%convert%'
          AND COALESCE(wt.reason, '') NOT ILIKE '%investment%'
          AND COALESCE(wt.reason, '') NOT ILIKE '%locked %'
          AND wt.id NOT LIKE 'dayfi-bill-%'
          AND wt.id NOT LIKE 'wt-inv-dep-%'
        LIMIT 1
      ) AS send,
      EXISTS (
        SELECT 1
        FROM wallet_transactions wt
        LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
        WHERE wt.user_id = $1
          AND wt.status::text ILIKE '%collection%'
          AND COALESCE(wt.receive_amount, 0) > 0
          AND COALESCE(b.name, '') NOT ILIKE '%currency conversion%'
          AND COALESCE(wt.reason, '') NOT ILIKE '%convert%'
          AND (
            COALESCE(b.name, '') ILIKE '%wallet top up%'
            OR wt.receive_channel IN ('crypto', 'bank')
            OR COALESCE(wt.reason, '') ILIKE '%deposit%'
          )
        LIMIT 1
      ) AS add,
      EXISTS (
        SELECT 1
        FROM wallet_transactions wt
        LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
        WHERE wt.user_id = $1
          AND (
            COALESCE(wt.reason, '') ILIKE '%convert%'
            OR COALESCE(b.name, '') ILIKE '%currency conversion%'
            OR wt.id LIKE 'wt-swap-%'
          )
        LIMIT 1
      ) AS swap,
      EXISTS (
        SELECT 1
        FROM wallet_transactions wt
        LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
        WHERE wt.user_id = $1
          AND (
            wt.id LIKE 'dayfi-bill-%'
            OR COALESCE(b.name, '') ILIKE '%bill payment%'
            OR (
              wt.status = 'success-payment'
              AND COALESCE(wt.reason, '') LIKE '%·%'
              AND wt.send_channel = 'bank'
            )
          )
        LIMIT 1
      ) AS pay,
      EXISTS (
        SELECT 1
        FROM wallet_transactions wt
        LEFT JOIN beneficiaries b ON b.id = wt.beneficiary_id
        WHERE wt.user_id = $1
          AND (
            COALESCE(b.name, '') ILIKE '%investment pocket%'
            OR COALESCE(wt.reason, '') ILIKE '%investment%'
            OR COALESCE(wt.reason, '') ILIKE '%locked %'
            OR wt.id LIKE 'wt-inv-dep-%'
          )
        LIMIT 1
      ) AS invest,
      EXISTS (
        SELECT 1
        FROM wallet_transactions wt
        WHERE wt.user_id = $1
          AND COALESCE(wt.reason, '') ILIKE '%budget%'
        LIMIT 1
      ) AS budget_tx
    `,
    [userId]
  );

  let budgetCreated = false;
  try {
    const createdRow = await db.oneOrNone<{ ok: boolean }>(
      `SELECT true AS ok FROM budgets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    budgetCreated = createdRow?.ok === true;
  } catch {
    budgetCreated = false;
  }

  let budgetSpent = false;
  try {
    const budgetRow = await db.oneOrNone<{ ok: boolean }>(
      `SELECT true AS ok FROM budgets
       WHERE user_id = $1 AND COALESCE(spent_amount, 0) > 0
       LIMIT 1`,
      [userId]
    );
    budgetSpent = budgetRow?.ok === true;
  } catch {
    budgetSpent = false;
  }

  if (!row) {
    return {
      send: false,
      add: false,
      swap: false,
      pay: false,
      invest: false,
      budget: budgetSpent || budgetCreated,
    };
  }

  return {
    send: row.send,
    add: row.add,
    swap: row.swap,
    pay: row.pay,
    invest: row.invest,
    budget: row.budget_tx || budgetSpent || budgetCreated,
  };
}
