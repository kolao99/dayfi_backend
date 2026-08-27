DROP INDEX IF EXISTS idx_infra_settlements_collection;
DROP INDEX IF EXISTS uq_infra_settlements_collection_rail;
DROP INDEX IF EXISTS uq_infra_settlements_payout_rail;

CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_settlements_payout_rail
  ON infra_settlements (payout_transaction_id, rail)
  WHERE status IN ('pending', 'submitted', 'confirmed');

ALTER TABLE infra_settlements DROP CONSTRAINT IF EXISTS chk_infra_settlements_tx_ref;

DELETE FROM infra_settlements WHERE collection_transaction_id IS NOT NULL;

ALTER TABLE infra_settlements DROP COLUMN IF EXISTS collection_transaction_id;

ALTER TABLE infra_settlements
  ALTER COLUMN payout_transaction_id SET NOT NULL;

ALTER TABLE infra_settlements DROP CONSTRAINT IF EXISTS infra_settlements_status_check;

ALTER TABLE infra_settlements
  ADD CONSTRAINT infra_settlements_status_check
  CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'cancelled'));
