CREATE TABLE IF NOT EXISTS azap_conversation_state (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  phone_e164 TEXT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_azap_conversation_state_user
  ON azap_conversation_state (user_id);

CREATE TABLE IF NOT EXISTS azap_entity_aliases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recipient', 'biller')),
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  target_id TEXT NOT NULL,
  display_label TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS azap_entity_aliases_user_kind_alias
  ON azap_entity_aliases (user_id, kind, alias_normalized);

CREATE INDEX IF NOT EXISTS idx_azap_entity_aliases_user_kind
  ON azap_entity_aliases (user_id, kind);

CREATE TABLE IF NOT EXISTS azap_consent_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  consent_type TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  channel TEXT,
  source TEXT,
  authorization_method TEXT,
  presented_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_azap_consent_user_type_version
  ON azap_consent_records (user_id, consent_type, version);

CREATE TABLE IF NOT EXISTS azap_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  template_version TEXT,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS azap_notifications_dedupe
  ON azap_notifications (user_id, event, idempotency_key);

CREATE TABLE IF NOT EXISTS azap_audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  channel TEXT,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_azap_audit_user_created
  ON azap_audit_events (user_id, created_at DESC);
