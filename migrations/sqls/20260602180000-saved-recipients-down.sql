DROP INDEX IF EXISTS idx_source_beneficiary_id;
DROP INDEX IF EXISTS idx_beneficiaries_user_saved;

ALTER TABLE beneficiaries DROP COLUMN IF EXISTS saved_manually;
ALTER TABLE source DROP COLUMN IF EXISTS ledger_currency;
