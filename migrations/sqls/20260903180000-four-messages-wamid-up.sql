-- Meta Cloud API wamid values exceed VARCHAR(64) (often ~80–120 chars).
-- That caused inbound WhatsApp inserts to fail after typing indicator, with no reply.
ALTER TABLE four_messages
  ALTER COLUMN client_message_id TYPE TEXT;
