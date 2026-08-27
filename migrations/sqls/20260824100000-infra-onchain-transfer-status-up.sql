-- E-ONCHAIN: processing / submitted / failed on internal transfers.

ALTER TABLE infra_internal_transfers
  DROP CONSTRAINT IF EXISTS infra_internal_transfers_status_check;

ALTER TABLE infra_internal_transfers
  ADD CONSTRAINT infra_internal_transfers_status_check
  CHECK (status IN ('processing', 'submitted', 'completed', 'failed'));
