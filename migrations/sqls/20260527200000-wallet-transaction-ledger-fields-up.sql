ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS ledger_currency VARCHAR(10),
  ADD COLUMN IF NOT EXISTS activity_kind VARCHAR(32),
  ADD COLUMN IF NOT EXISTS external_reference VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_external_ref
  ON wallet_transactions(external_reference);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_activity
  ON wallet_transactions(user_id, activity_kind, timestamp DESC);

-- Backfill history from existing ledger credits/debits (Stellar, Flutterwave, etc.)
INSERT INTO wallet_transactions (
  id, user_id, status, reason,
  receive_amount, receive_channel, receive_network,
  ledger_currency, activity_kind, external_reference, timestamp
)
SELECT
  'wt-' || REPLACE(COALESCE(lm.external_reference, lm.id), ':', '-'),
  lm.user_id,
  'success-collection',
  COALESCE(lm.metadata->>'assetCode', lm.currency) || ' deposit via ' || lm.source,
  lm.amount,
  CASE
    WHEN lm.source = 'stellar' THEN 'crypto'::channel
    WHEN lm.source = 'flutterwave' THEN 'bank'::channel
    ELSE 'wallet'::channel
  END,
  CASE WHEN lm.source = 'stellar' THEN 'stellar'::network ELSE NULL END,
  lm.currency,
  'deposit',
  lm.external_reference,
  lm.created_at
FROM ledger_movements lm
WHERE lm.direction = 'credit'
  AND lm.source IN ('stellar', 'flutterwave', 'grey', 'manual')
  AND NOT EXISTS (
    SELECT 1 FROM wallet_transactions wt
    WHERE wt.id = 'wt-' || REPLACE(COALESCE(lm.external_reference, lm.id), ':', '-')
  );

-- Update FX defaults to market-ish rates (20 EUR ≈ 23.25 USD → 1.1625)
UPDATE exchange_rates SET rate = 1.162500, updated_at = CURRENT_TIMESTAMP
  WHERE base_currency = 'EUR' AND target_currency = 'USD';
UPDATE exchange_rates SET rate = 0.860215, updated_at = CURRENT_TIMESTAMP
  WHERE base_currency = 'USD' AND target_currency = 'EUR';

INSERT INTO exchange_rates (base_currency, target_currency, rate, source)
VALUES
  ('EUR', 'USD', 1.162500, 'platform_default'),
  ('USD', 'EUR', 0.860215, 'platform_default')
ON CONFLICT (base_currency, target_currency) DO UPDATE
  SET rate = EXCLUDED.rate, updated_at = CURRENT_TIMESTAMP;
