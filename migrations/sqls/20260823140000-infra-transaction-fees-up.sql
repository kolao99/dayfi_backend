-- Fee / custody architecture: Dayfi USDC fee vs Stellar XLM network cost.

ALTER TABLE infra_internal_transfers
  ADD COLUMN IF NOT EXISTS settlement_mode VARCHAR(32) NOT NULL DEFAULT 'INTERNAL_LEDGER';

ALTER TABLE infra_internal_transfers
  DROP CONSTRAINT IF EXISTS infra_internal_transfers_settlement_mode_check;

ALTER TABLE infra_internal_transfers
  ADD CONSTRAINT infra_internal_transfers_settlement_mode_check
  CHECK (settlement_mode IN ('INTERNAL_LEDGER', 'STELLAR_ONCHAIN'));

ALTER TABLE infra_internal_transfers
  ADD COLUMN IF NOT EXISTS fee_id UUID;

CREATE TABLE IF NOT EXISTS infra_transaction_fees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  transfer_group_id UUID REFERENCES infra_internal_transfers(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES infra_transactions(id) ON DELETE SET NULL,
  fee_type VARCHAR(64) NOT NULL DEFAULT 'DAYFI_TRANSACTION_FEE',
  fee_amount_usdc NUMERIC(28, 7) NOT NULL CHECK (fee_amount_usdc >= 0),
  fee_currency VARCHAR(8) NOT NULL DEFAULT 'USDC',
  transfer_amount NUMERIC(28, 7) NOT NULL CHECK (transfer_amount > 0),
  customer_debit_amount NUMERIC(28, 7) NOT NULL CHECK (customer_debit_amount > 0),
  actual_network_fee_amount NUMERIC(28, 7),
  actual_network_fee_currency VARCHAR(8),
  fee_revenue_amount NUMERIC(28, 7) NOT NULL CHECK (fee_revenue_amount >= 0),
  fee_revenue_org_id UUID REFERENCES infra_organizations(id) ON DELETE SET NULL,
  customer_fee_movement_id UUID REFERENCES infra_ledger_movements(id) ON DELETE SET NULL,
  revenue_movement_id UUID REFERENCES infra_ledger_movements(id) ON DELETE SET NULL,
  settlement_mode VARCHAR(32) NOT NULL DEFAULT 'INTERNAL_LEDGER'
    CHECK (settlement_mode IN ('INTERNAL_LEDGER', 'STELLAR_ONCHAIN')),
  idempotency_key VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('quoted', 'recorded', 'skipped')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_infra_transaction_fees_org_env
  ON infra_transaction_fees (org_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_transaction_fees_transfer
  ON infra_transaction_fees (transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;

ALTER TABLE infra_internal_transfers
  DROP CONSTRAINT IF EXISTS infra_internal_transfers_fee_id_fkey;

ALTER TABLE infra_internal_transfers
  ADD CONSTRAINT infra_internal_transfers_fee_id_fkey
  FOREIGN KEY (fee_id) REFERENCES infra_transaction_fees(id) ON DELETE SET NULL;
