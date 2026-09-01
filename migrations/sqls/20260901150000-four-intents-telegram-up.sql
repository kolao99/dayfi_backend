-- Four Phase 3a: active intent state + Telegram identity linking.
--
-- Active intents are separate from conversation messages (rule §39).
-- Telegram links map a Telegram user to an existing Dayfi user after phone OTP.

CREATE TABLE IF NOT EXISTS four_active_intents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL
    REFERENCES four_conversations(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  intent VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'COLLECTING_INFORMATION',
  slots JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')
);

-- One active intent per conversation at a time.
CREATE UNIQUE INDEX IF NOT EXISTS four_active_intents_conversation_key
  ON four_active_intents (conversation_id);

CREATE INDEX IF NOT EXISTS idx_four_active_intents_user_status
  ON four_active_intents (user_id, status);

CREATE TABLE IF NOT EXISTS four_telegram_links (
  telegram_user_id BIGINT PRIMARY KEY,
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  chat_id BIGINT,
  telegram_username VARCHAR(64),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS four_telegram_links_user_key
  ON four_telegram_links (user_id);
