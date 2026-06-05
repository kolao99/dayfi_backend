-- Consolidate legacy per-currency ledger balances into the USD wallet (global pool).

WITH rates AS (
  SELECT base_currency, target_currency, rate::numeric AS rate
  FROM exchange_rates
  WHERE target_currency = 'USD'
),
user_totals AS (
  SELECT
    w.user_id,
    COALESCE(SUM(
      CASE
        WHEN w.currency = 'USD' THEN w.balance::numeric
        WHEN r.rate IS NOT NULL THEN w.balance::numeric * r.rate
        ELSE 0
      END
    ), 0) AS total_usd
  FROM wallets w
  LEFT JOIN rates r ON r.base_currency = w.currency
  WHERE w.currency IN ('USD', 'GBP', 'EUR', 'NGN')
  GROUP BY w.user_id
)
UPDATE wallets usd
SET
  balance = ut.total_usd,
  updated_at = CURRENT_TIMESTAMP
FROM user_totals ut
WHERE usd.user_id = ut.user_id
  AND usd.currency = 'USD';

UPDATE wallets
SET balance = 0, updated_at = CURRENT_TIMESTAMP
WHERE currency IN ('GBP', 'EUR', 'NGN');
