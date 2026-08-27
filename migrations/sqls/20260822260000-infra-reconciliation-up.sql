-- Phase 6: Reconciliation observes provider + ledger + settlement.
-- Does not move money. Placeholder infra_reconciliation_items is replaced.

DROP TABLE IF EXISTS infra_reconciliation_items;

CREATE TABLE IF NOT EXISTS infra_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  trigger_source VARCHAR(32) NOT NULL DEFAULT 'api'
    CHECK (trigger_source IN ('api', 'manual', 'scheduled', 'test')),
  -- Optional filters: { "direction": "payment"|"payout", "transactionIds": ["..."] }
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_infra_recon_runs_org_env
  ON infra_reconciliation_runs (org_id, environment, created_at DESC);

CREATE TABLE IF NOT EXISTS infra_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  run_id UUID NOT NULL REFERENCES infra_reconciliation_runs(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES infra_transactions(id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('payment', 'payout')),
  -- Overall outcome
  status VARCHAR(32) NOT NULL
    CHECK (status IN ('reconciled', 'mismatch', 'incomplete', 'skipped')),
  result_code VARCHAR(64) NOT NULL,
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  expected_amount NUMERIC(28, 7),
  -- Provider leg (observed)
  provider_present BOOLEAN NOT NULL DEFAULT false,
  provider_name VARCHAR(64),
  provider_reference VARCHAR(255),
  provider_status VARCHAR(64),
  provider_amount NUMERIC(28, 7),
  -- Ledger leg (observed)
  ledger_present BOOLEAN NOT NULL DEFAULT false,
  ledger_movement_id UUID,
  ledger_status VARCHAR(64),
  ledger_amount NUMERIC(28, 7),
  -- Settlement leg (observed; may be not_applicable)
  settlement_required BOOLEAN NOT NULL DEFAULT false,
  settlement_present BOOLEAN NOT NULL DEFAULT false,
  settlement_id UUID,
  settlement_rail VARCHAR(32),
  settlement_status VARCHAR(64),
  settlement_amount NUMERIC(28, 7),
  settlement_external_reference VARCHAR(255),
  -- Explanation payload for operators / Phase 7 UI
  legs JSONB NOT NULL DEFAULT '{}'::jsonb,
  mismatches JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_infra_recon_items_org_env
  ON infra_reconciliation_items (org_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_recon_items_tx
  ON infra_reconciliation_items (transaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_recon_items_status
  ON infra_reconciliation_items (org_id, environment, status, result_code);

CREATE INDEX IF NOT EXISTS idx_infra_recon_items_result
  ON infra_reconciliation_items (org_id, environment, result_code);
