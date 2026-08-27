-- Increment E: direction 'internal_transfer' is 18 chars; columns were VARCHAR(16).

ALTER TABLE infra_transactions
  ALTER COLUMN direction TYPE VARCHAR(32);

ALTER TABLE infra_reconciliation_items
  ALTER COLUMN direction TYPE VARCHAR(32);
