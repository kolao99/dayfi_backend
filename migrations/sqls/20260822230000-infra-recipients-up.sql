-- Phase 3: org-scoped recipients + rail-agnostic destinations.
-- Recipient = who is paid. Destination = how Dayfi reaches them.
-- Sensitive destination_data is never required in list/read API responses.

CREATE TABLE IF NOT EXISTS infra_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  display_name VARCHAR(255) NOT NULL,
  country VARCHAR(8),
  email VARCHAR(255),
  phone VARCHAR(32),
  status VARCHAR(32) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_recipients_org_env
  ON infra_recipients (org_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_recipients_org_name
  ON infra_recipients (org_id, environment, LOWER(display_name));

CREATE TABLE IF NOT EXISTS infra_recipient_destinations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID NOT NULL REFERENCES infra_recipients(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  -- bank | mobile_money | crypto | dayfi
  rail VARCHAR(32) NOT NULL
    CHECK (rail IN ('bank', 'mobile_money', 'crypto', 'dayfi')),
  country VARCHAR(8),
  currency VARCHAR(16),
  provider VARCHAR(128),
  label VARCHAR(128),
  -- Safe for list/UI (never full account/wallet)
  display_hint VARCHAR(255) NOT NULL DEFAULT '',
  last_four VARCHAR(16),
  verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed')),
  -- Sensitive payout payload (account number, wallet address, etc.)
  destination_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_destinations_recipient
  ON infra_recipient_destinations (recipient_id, status);

CREATE INDEX IF NOT EXISTS idx_infra_destinations_org_env
  ON infra_recipient_destinations (org_id, environment, created_at DESC);

-- At most one default destination per recipient
CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_dest_default
  ON infra_recipient_destinations (recipient_id)
  WHERE is_default = TRUE AND status = 'active';
