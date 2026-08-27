ALTER TABLE infra_members
  DROP COLUMN IF EXISTS last_name,
  DROP COLUMN IF EXISTS first_name,
  DROP COLUMN IF EXISTS otp_purpose;
