DROP INDEX IF EXISTS idx_azap_audit_user_created;
DROP TABLE IF EXISTS azap_audit_events;

DROP INDEX IF EXISTS azap_notifications_dedupe;
DROP TABLE IF EXISTS azap_notifications;

DROP INDEX IF EXISTS idx_azap_consent_user_type_version;
DROP TABLE IF EXISTS azap_consent_records;

DROP INDEX IF EXISTS idx_azap_entity_aliases_user_kind;
DROP INDEX IF EXISTS azap_entity_aliases_user_kind_alias;
DROP TABLE IF EXISTS azap_entity_aliases;

DROP INDEX IF EXISTS idx_azap_conversation_state_user;
DROP TABLE IF EXISTS azap_conversation_state;
