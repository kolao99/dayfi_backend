-- Increment E: Dayfi → Dayfi internal transfers (ledger-only, no Stellar).

ALTER TABLE infra_transactions
  DROP CONSTRAINT IF EXISTS infra_transactions_direction_check;

ALTER TABLE infra_transactions
  ADD CONSTRAINT infra_transactions_direction_check
  CHECK (direction IN ('payment', 'payout', 'settlement', 'fee', 'other', 'deposit', 'internal_transfer'));

ALTER TABLE infra_reconciliation_items
  DROP CONSTRAINT IF EXISTS infra_reconciliation_items_direction_check;

ALTER TABLE infra_reconciliation_items
  ADD CONSTRAINT infra_reconciliation_items_direction_check
  CHECK (direction IN ('payment', 'payout', 'deposit', 'internal_transfer'));

CREATE TABLE IF NOT EXISTS infra_internal_transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  recipient_org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  amount NUMERIC(28, 7) NOT NULL CHECK (amount > 0),
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  status VARCHAR(32) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed')),
  sender_transaction_id UUID REFERENCES infra_transactions(id) ON DELETE SET NULL,
  recipient_transaction_id UUID REFERENCES infra_transactions(id) ON DELETE SET NULL,
  sender_movement_id UUID REFERENCES infra_ledger_movements(id) ON DELETE SET NULL,
  recipient_movement_id UUID REFERENCES infra_ledger_movements(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(255),
  request_fingerprint VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT infra_internal_transfers_not_self CHECK (sender_org_id <> recipient_org_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_internal_transfers_idem
  ON infra_internal_transfers (sender_org_id, environment, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_infra_internal_transfers_sender
  ON infra_internal_transfers (sender_org_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_internal_transfers_recipient
  ON infra_internal_transfers (recipient_org_id, environment, created_at DESC);
