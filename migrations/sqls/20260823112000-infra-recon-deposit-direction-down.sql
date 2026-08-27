ALTER TABLE infra_reconciliation_items
  DROP CONSTRAINT IF EXISTS infra_reconciliation_items_direction_check;

ALTER TABLE infra_reconciliation_items
  ADD CONSTRAINT infra_reconciliation_items_direction_check
  CHECK (direction IN ('payment', 'payout'));
