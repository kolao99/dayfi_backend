ALTER TABLE source
  ADD COLUMN IF NOT EXISTS ledger_currency VARCHAR(10);

ALTER TABLE beneficiaries
  ADD COLUMN IF NOT EXISTS saved_manually BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_beneficiaries_user_saved
  ON beneficiaries (user_id, saved_manually)
  WHERE saved_manually = TRUE;

CREATE INDEX IF NOT EXISTS idx_source_beneficiary_id
  ON source (beneficiary_id);
