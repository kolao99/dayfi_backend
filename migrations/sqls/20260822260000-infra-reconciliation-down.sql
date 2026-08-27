DROP TABLE IF EXISTS infra_reconciliation_items;
DROP TABLE IF EXISTS infra_reconciliation_runs;

-- Restore Phase-0 placeholder shape (empty).
CREATE TABLE IF NOT EXISTS infra_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  dayfi_amount BIGINT,
  provider_amount BIGINT,
  currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
  provider VARCHAR(64),
  reference VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'matched'
    CHECK (status IN ('matched', 'mismatch', 'missing')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_recon_org_env
  ON infra_reconciliation_items (org_id, environment, created_at DESC);
