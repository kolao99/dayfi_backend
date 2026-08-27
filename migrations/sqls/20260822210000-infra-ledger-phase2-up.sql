-- Phase 2: ledger reference linkage for idempotent Collect/Send lifecycle.

ALTER TABLE infra_ledger_movements
  ADD COLUMN IF NOT EXISTS reference_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS reference_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_infra_ledger_ref
  ON infra_ledger_movements (org_id, environment, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- One money event per (org, env, reference, movement_type) — webhook retries must not double-post.
CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_ledger_ref_movement
  ON infra_ledger_movements (org_id, environment, reference_type, reference_id, movement_type)
  WHERE reference_id IS NOT NULL AND reference_type IS NOT NULL;
