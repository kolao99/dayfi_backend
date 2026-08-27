ALTER TABLE infra_transactions
  DROP CONSTRAINT IF EXISTS infra_transactions_direction_check;

ALTER TABLE infra_transactions
  ADD CONSTRAINT infra_transactions_direction_check
  CHECK (direction IN ('payment', 'payout', 'settlement', 'fee', 'other'));
