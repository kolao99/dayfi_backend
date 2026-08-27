-- Business infra auth: OTP/Google, nullable org until setup, real ledger tables (empty).

ALTER TABLE infra_members
  ALTER COLUMN org_id DROP NOT NULL;

ALTER TABLE infra_members
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE infra_members
  ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_members_email_unique
  ON infra_members (LOWER(email));

CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_members_google_sub
  ON infra_members (google_sub)
  WHERE google_sub IS NOT NULL;

ALTER TABLE infra_organizations
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified'));

CREATE TABLE IF NOT EXISTS infra_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  amount BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
  country VARCHAR(8),
  status VARCHAR(32) NOT NULL,
  method VARCHAR(64),
  direction VARCHAR(16) NOT NULL DEFAULT 'payment'
    CHECK (direction IN ('payment', 'payout', 'settlement', 'fee', 'other')),
  fee BIGINT NOT NULL DEFAULT 0,
  external_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_tx_org_env_created
  ON infra_transactions (org_id, environment, created_at DESC);

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
