-- Increment B: per-org Stellar accounts (public metadata) + custody vault (encrypted secrets).
-- Ledger remains infra_wallet_accounts; this table is on-chain custody identity only.
-- NEVER expose secret_encrypted through APIs or organization records.

CREATE TABLE IF NOT EXISTS infra_stellar_custody (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  secret_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infra_stellar_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  public_key VARCHAR(56) NOT NULL,
  network VARCHAR(16) NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  usdc_issuer VARCHAR(56),
  status VARCHAR(32) NOT NULL DEFAULT 'provisioning'
    CHECK (status IN (
      'provisioning',
      'xlm_ready',
      'trustline_ready',
      'active',
      'failed'
    )),
  custody_ref UUID NOT NULL REFERENCES infra_stellar_custody(id) ON DELETE RESTRICT,
  failure_reason TEXT,
  xlm_funded_at TIMESTAMPTZ,
  trustline_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, environment, network, asset)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_stellar_accounts_public_key
  ON infra_stellar_accounts (public_key);

CREATE INDEX IF NOT EXISTS idx_infra_stellar_accounts_org_env
  ON infra_stellar_accounts (org_id, environment);

CREATE INDEX IF NOT EXISTS idx_infra_stellar_accounts_status
  ON infra_stellar_accounts (status)
  WHERE status <> 'active';
