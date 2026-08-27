-- Increment G: manual treasury rebalance audit trail (Dayfi-owned liquidity only).
-- Never stores private keys. Customer wallets must never appear as source.

CREATE TABLE IF NOT EXISTS infra_treasury_rebalances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  source_kind VARCHAR(32) NOT NULL DEFAULT 'dayfi_treasury',
  destination_kind VARCHAR(32) NOT NULL DEFAULT 'dayfi_treasury',
  source_ref VARCHAR(255) NOT NULL,
  destination_ref VARCHAR(255) NOT NULL,
  amount NUMERIC(28, 7) NOT NULL CHECK (amount > 0),
  status VARCHAR(32) NOT NULL DEFAULT 'requested'
    CHECK (status IN (
      'requested',
      'approved',
      'submitted',
      'confirmed',
      'failed',
      'cancelled'
    )),
  purpose VARCHAR(64) NOT NULL DEFAULT 'manual',
  external_reference VARCHAR(255),
  rail VARCHAR(32) NOT NULL DEFAULT 'STELLAR',
  rail_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  requested_by VARCHAR(255),
  liabilities_snapshot NUMERIC(28, 7),
  liquidity_snapshot NUMERIC(28, 7),
  shortfall_snapshot NUMERIC(28, 7),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (environment, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_infra_treasury_rebalances_env_status
  ON infra_treasury_rebalances (environment, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_treasury_rebalances_external
  ON infra_treasury_rebalances (external_reference)
  WHERE external_reference IS NOT NULL;
