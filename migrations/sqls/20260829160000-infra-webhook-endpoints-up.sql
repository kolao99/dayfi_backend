CREATE TABLE IF NOT EXISTS infra_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  label VARCHAR(255) NOT NULL DEFAULT 'Webhook endpoint',
  url TEXT NOT NULL,
  secret_hash VARCHAR(255) NOT NULL,
  secret_prefix VARCHAR(24) NOT NULL,
  secret_last_four VARCHAR(8) NOT NULL,
  events JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_by UUID REFERENCES infra_members(id),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_webhook_endpoints_org_env
  ON infra_webhook_endpoints (org_id, environment)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS infra_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES infra_webhook_endpoints(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  event_type VARCHAR(128) NOT NULL,
  resource_type VARCHAR(64),
  resource_id VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'success', 'failed')),
  attempt_count INT NOT NULL DEFAULT 0,
  http_status INT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_infra_webhook_deliveries_org_created
  ON infra_webhook_deliveries (org_id, created_at DESC);
