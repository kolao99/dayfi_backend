DROP INDEX IF EXISTS uq_infra_ledger_ref_movement;
DROP INDEX IF EXISTS idx_infra_ledger_ref;

ALTER TABLE infra_ledger_movements
  DROP COLUMN IF EXISTS reference_id,
  DROP COLUMN IF EXISTS reference_type;
