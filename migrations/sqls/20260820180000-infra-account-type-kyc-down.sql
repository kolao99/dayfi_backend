DROP INDEX IF EXISTS infra_members_dayfi_tag_uidx;

ALTER TABLE infra_members
  DROP COLUMN IF EXISTS account_type,
  DROP COLUMN IF EXISTS dayfi_tag,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS date_of_birth,
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS bvn,
  DROP COLUMN IF EXISTS kyc_level,
  DROP COLUMN IF EXISTS personal_onboarding_complete;
