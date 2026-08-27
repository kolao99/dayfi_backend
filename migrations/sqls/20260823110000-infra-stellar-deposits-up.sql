-- Increment D: external Stellar USDC deposits into org Dayfi wallets.
-- Detection + verification + ledger pending → available.
-- Never stores private keys. Idempotency: deposit:{stellarTxHash}

CREATE TABLE IF NOT EXISTS infra_stellar_deposits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  stellar_account_id UUID REFERENCES infra_stellar_accounts(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES infra_transactions(id) ON DELETE SET NULL,
  stellar_tx_hash VARCHAR(64) NOT NULL,
  source_public_key VARCHAR(56),
  destination_public_key VARCHAR(56) NOT NULL,
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  asset_issuer VARCHAR(56) NOT NULL,
  amount NUMERIC(28, 7) NOT NULL CHECK (amount > 0),
  network VARCHAR(16) NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  status VARCHAR(32) NOT NULL DEFAULT 'detected'
    CHECK (status IN (
      'detected',
      'verified',
      'pending_ledger',
      'confirmed',
      'rejected',
      'failed'
    )),
  ledger_pending_movement_id UUID,
  ledger_available_movement_id UUID,
  failure_reason TEXT,
  idempotency_key VARCHAR(128) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_infra_stellar_deposits_hash UNIQUE (stellar_tx_hash),
  CONSTRAINT uq_infra_stellar_deposits_idem UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_infra_stellar_deposits_org_env
  ON infra_stellar_deposits (org_id, environment);

CREATE INDEX IF NOT EXISTS idx_infra_stellar_deposits_destination
  ON infra_stellar_deposits (destination_public_key);

CREATE INDEX IF NOT EXISTS idx_infra_stellar_deposits_status
  ON infra_stellar_deposits (status)
  WHERE status <> 'confirmed';

CREATE INDEX IF NOT EXISTS idx_infra_stellar_deposits_transaction
  ON infra_stellar_deposits (transaction_id)
  WHERE transaction_id IS NOT NULL;
