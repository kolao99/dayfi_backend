CREATE TABLE IF NOT EXISTS infra_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infra_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  role VARCHAR(32) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_infra_members_email ON infra_members (LOWER(email));

CREATE TABLE IF NOT EXISTS infra_invite_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(64) NOT NULL UNIQUE,
  assigned_email VARCHAR(255),
  max_uses INT NOT NULL DEFAULT 100,
  uses_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infra_api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL,
  prefix VARCHAR(16) NOT NULL,
  last_four VARCHAR(8) NOT NULL,
  created_by UUID REFERENCES infra_members(id),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_infra_api_keys_org_env
  ON infra_api_keys (org_id, environment)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS infra_api_key_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  key_id UUID REFERENCES infra_api_keys(id) ON DELETE SET NULL,
  action VARCHAR(64) NOT NULL,
  actor_email VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Demo org + invite (password: dayfi)
INSERT INTO infra_organizations (id, name, slug)
VALUES ('a0000000-0000-4000-8000-000000000001', 'Acme Corporation', 'acme')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO infra_members (org_id, email, password_hash, name, role)
SELECT
  o.id,
  'builder@acme.co',
  '$2b$10$d1DOb7aUEbi7c33Kbp5TF.ogZCHh.3IwWlKb54w79rzdYeuqKM2Qy',
  'builder',
  'admin'
FROM infra_organizations o
WHERE o.slug = 'acme'
ON CONFLICT (org_id, email) DO NOTHING;

INSERT INTO infra_invite_codes (code, max_uses)
VALUES ('DAYFI-INFRA', 1000), ('DAYFI', 1000), ('BUILD', 1000)
ON CONFLICT (code) DO NOTHING;
