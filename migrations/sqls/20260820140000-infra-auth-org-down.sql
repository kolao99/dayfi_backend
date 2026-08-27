DROP TABLE IF EXISTS infra_reconciliation_items;
DROP TABLE IF EXISTS infra_transactions;

ALTER TABLE infra_organizations DROP COLUMN IF EXISTS verification_status;

DROP INDEX IF EXISTS idx_infra_members_google_sub;
DROP INDEX IF EXISTS idx_infra_members_email_unique;

ALTER TABLE infra_members
  DROP COLUMN IF EXISTS google_sub,
  DROP COLUMN IF EXISTS otp_expires_at,
  DROP COLUMN IF EXISTS otp_code;

-- Restore NOT NULL only where safe; leave nullable if rows have nulls.
UPDATE infra_members SET password_hash = '' WHERE password_hash IS NULL;
ALTER TABLE infra_members ALTER COLUMN password_hash SET NOT NULL;
