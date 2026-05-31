CREATE UNIQUE INDEX IF NOT EXISTS wallets_dayfi_id_unique_idx
ON wallets (LOWER(TRIM(BOTH '@' FROM dayfi_id)))
WHERE dayfi_id IS NOT NULL AND TRIM(dayfi_id) <> '';
