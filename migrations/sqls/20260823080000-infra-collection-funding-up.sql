-- Increment C: collection wallet funding via Stellar (treasury → org wallet).
-- Extends infra_settlements to link collection transactions, not just payouts.

ALTER TABLE infra_settlements
  ALTER COLUMN payout_transaction_id DROP NOT NULL;

ALTER TABLE infra_settlements
  ADD COLUMN IF NOT EXISTS collection_transaction_id UUID
    REFERENCES infra_transactions(id) ON DELETE CASCADE;

ALTER TABLE infra_settlements
  DROP CONSTRAINT IF EXISTS infra_settlements_status_check;

ALTER TABLE infra_settlements
  ADD CONSTRAINT infra_settlements_status_check
  CHECK (status IN (
    'pending',
    'submitted',
    'confirmed',
    'failed',
    'cancelled',
    'pending_treasury'
  ));

ALTER TABLE infra_settlements
  DROP CONSTRAINT IF EXISTS chk_infra_settlements_tx_ref;

ALTER TABLE infra_settlements
  ADD CONSTRAINT chk_infra_settlements_tx_ref
  CHECK (
    payout_transaction_id IS NOT NULL
    OR collection_transaction_id IS NOT NULL
  );

DROP INDEX IF EXISTS uq_infra_settlements_payout_rail;

CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_settlements_payout_rail
  ON infra_settlements (payout_transaction_id, rail)
  WHERE payout_transaction_id IS NOT NULL
    AND status IN ('pending', 'submitted', 'confirmed', 'pending_treasury');

CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_settlements_collection_rail
  ON infra_settlements (collection_transaction_id, rail)
  WHERE collection_transaction_id IS NOT NULL
    AND status IN ('pending', 'submitted', 'confirmed', 'pending_treasury');

CREATE INDEX IF NOT EXISTS idx_infra_settlements_collection
  ON infra_settlements (collection_transaction_id)
  WHERE collection_transaction_id IS NOT NULL;
