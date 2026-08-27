DROP TABLE IF EXISTS infra_internal_transfers;

ALTER TABLE infra_transactions
  DROP CONSTRAINT IF EXISTS infra_transactions_direction_check;

ALTER TABLE infra_transactions
  ADD CONSTRAINT infra_transactions_direction_check
  CHECK (direction IN ('payment', 'payout', 'settlement', 'fee', 'other', 'deposit'));

ALTER TABLE infra_reconciliation_items
  DROP CONSTRAINT IF EXISTS infra_reconciliation_items_direction_check;

ALTER TABLE infra_reconciliation_items
  ADD CONSTRAINT infra_reconciliation_items_direction_check
  CHECK (direction IN ('payment', 'payout', 'deposit'));
