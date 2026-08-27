-- Dayfi Back Office: operators, audit, invite enrichment

CREATE TABLE IF NOT EXISTS infra_operators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  role VARCHAR(32) NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('viewer', 'support', 'ops', 'treasury', 'admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_operators_email_lower
  ON infra_operators (LOWER(email));

CREATE TABLE IF NOT EXISTS infra_operator_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID REFERENCES infra_operators(id) ON DELETE SET NULL,
  operator_email VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_operator_audit_created
  ON infra_operator_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_operator_audit_resource
  ON infra_operator_audit (resource_type, resource_id);

ALTER TABLE infra_invite_codes
  ADD COLUMN IF NOT EXISTS label VARCHAR(255),
  ADD COLUMN IF NOT EXISTS environment VARCHAR(16)
    CHECK (environment IS NULL OR environment IN ('test', 'live', 'both')),
  ADD COLUMN IF NOT EXISTS created_by_operator_id UUID
    REFERENCES infra_operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS redeemed_by_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_redeemed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_infra_invite_codes_assigned_email
  ON infra_invite_codes (LOWER(assigned_email))
  WHERE assigned_email IS NOT NULL;
