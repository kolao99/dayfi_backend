ALTER TABLE infra_internal_transfers
  DROP CONSTRAINT IF EXISTS infra_internal_transfers_fee_id_fkey;

ALTER TABLE infra_internal_transfers
  DROP COLUMN IF EXISTS fee_id;

ALTER TABLE infra_internal_transfers
  DROP CONSTRAINT IF EXISTS infra_internal_transfers_settlement_mode_check;

ALTER TABLE infra_internal_transfers
  DROP COLUMN IF EXISTS settlement_mode;

DROP TABLE IF EXISTS infra_transaction_fees;
