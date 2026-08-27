ALTER TABLE infra_transactions
  ALTER COLUMN direction TYPE VARCHAR(16);

ALTER TABLE infra_reconciliation_items
  ALTER COLUMN direction TYPE VARCHAR(16);
