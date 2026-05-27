DROP INDEX IF EXISTS idx_wallet_transactions_activity;
DROP INDEX IF EXISTS idx_wallet_transactions_external_ref;

ALTER TABLE wallet_transactions
  DROP COLUMN IF EXISTS external_reference,
  DROP COLUMN IF EXISTS activity_kind,
  DROP COLUMN IF EXISTS ledger_currency;
