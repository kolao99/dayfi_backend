-- Reverse of Four Phase 2 (C6).

DROP INDEX IF EXISTS four_messages_client_dedupe;
DROP INDEX IF EXISTS idx_four_messages_conversation_seq;
DROP TABLE IF EXISTS four_messages;

DROP INDEX IF EXISTS idx_four_conversations_user_recent;
DROP TABLE IF EXISTS four_conversations;
