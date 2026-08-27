DROP INDEX IF EXISTS idx_infra_invite_codes_assigned_email;

ALTER TABLE infra_invite_codes
  DROP COLUMN IF EXISTS last_redeemed_at,
  DROP COLUMN IF EXISTS redeemed_by_email,
  DROP COLUMN IF EXISTS created_by_operator_id,
  DROP COLUMN IF EXISTS environment,
  DROP COLUMN IF EXISTS label;

DROP TABLE IF EXISTS infra_operator_audit;
DROP TABLE IF EXISTS infra_operators;
