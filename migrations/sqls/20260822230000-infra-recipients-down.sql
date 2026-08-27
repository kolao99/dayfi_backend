DROP INDEX IF EXISTS uq_infra_dest_default;
DROP INDEX IF EXISTS idx_infra_destinations_org_env;
DROP INDEX IF EXISTS idx_infra_destinations_recipient;
DROP TABLE IF EXISTS infra_recipient_destinations;

DROP INDEX IF EXISTS idx_infra_recipients_org_name;
DROP INDEX IF EXISTS idx_infra_recipients_org_env;
DROP TABLE IF EXISTS infra_recipients;
