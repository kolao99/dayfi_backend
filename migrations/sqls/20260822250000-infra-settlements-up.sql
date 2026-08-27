-- Phase 5: rail-agnostic settlements (Stellar is the first adapter).
-- Parent financial model stays Dayfi ledger + payout; settlement is external proof.

CREATE TABLE IF NOT EXISTS infra_settlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  payout_transaction_id UUID NOT NULL REFERENCES infra_transactions(id) ON DELETE CASCADE,
  -- STELLAR | YELLOW_CARD | ...
  rail VARCHAR(32) NOT NULL,
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  amount NUMERIC(20, 7) NOT NULL,
  source_ref VARCHAR(255),
  destination_ref VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'submitted',
      'confirmed',
      'failed',
      'cancelled'
    )),
  -- Dayfi-level external proof (tx hash, provider id, etc.)
  external_reference VARCHAR(255),
  provider_reference VARCHAR(255),
  -- Adapter-specific payload (Stellar hash/ledger/op, YC ids, …)
  rail_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_settlements_payout_rail
  ON infra_settlements (payout_transaction_id, rail)
  WHERE status IN ('pending', 'submitted', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_infra_settlements_org_env
  ON infra_settlements (org_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_settlements_external
  ON infra_settlements (external_reference)
  WHERE external_reference IS NOT NULL;
