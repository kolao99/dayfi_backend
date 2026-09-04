-- Four WhatsApp channel identity linking.
-- Maps a WhatsApp phone (E.164) to an existing Dayfi user. One wallet per user.

CREATE TABLE IF NOT EXISTS four_whatsapp_links (
  whatsapp_phone_e164 VARCHAR(20) PRIMARY KEY,
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  display_name VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS four_whatsapp_links_user_key
  ON four_whatsapp_links (user_id);

CREATE INDEX IF NOT EXISTS idx_four_whatsapp_links_user
  ON four_whatsapp_links (user_id);
