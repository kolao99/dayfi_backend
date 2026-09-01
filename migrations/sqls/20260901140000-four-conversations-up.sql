-- Four Phase 2 (C6): backend-owned conversations and messages.
--
-- Nothing like this exists anywhere in the repo today. Kudi's chat is an
-- in-memory Riverpod list that dies with the process; DayX round-trips history
-- through the client. Four makes the BACKEND the source of truth so the
-- conversation survives app restarts, reinstalls and device changes.
--
-- Deliberately separate from execution state (rule §39): this pair of tables
-- records what was SAID. What the user is trying to DO (active intent) and what
-- actually MOVED MONEY (four_executions) are different objects in later phases.

CREATE TABLE IF NOT EXISTS four_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Seeded at creation so "most recent conversation" needs no COALESCE.
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Starting a new chat never destroys the old one (rule §17).
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_four_conversations_user_recent
  ON four_conversations (user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS four_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Monotonic insertion order. created_at alone is not a stable sort: two
  -- messages can share a timestamp and UUIDs do not order by insertion.
  seq BIGSERIAL NOT NULL,
  conversation_id UUID NOT NULL
    REFERENCES four_conversations(id) ON DELETE CASCADE,
  -- Denormalized so ownership can be enforced without a join on every read.
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  type VARCHAR(24) NOT NULL DEFAULT 'text'
    CHECK (type IN (
      'text', 'image', 'voice', 'review', 'payment', 'receipt',
      'bill', 'batch', 'choice', 'error', 'event'
    )),
  content TEXT,
  -- Structured payload for cards, and the tap-state of persistent buttons
  -- (rule §29) so disabled states survive a conversation reload.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Client-generated id: makes an offline retry idempotent instead of
  -- duplicating the message.
  client_message_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_four_messages_conversation_seq
  ON four_messages (conversation_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS four_messages_client_dedupe
  ON four_messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
