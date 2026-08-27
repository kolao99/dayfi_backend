-- Phase 1: Infra org wallets + ledger (financial source of truth).
-- Stellar settlement / YC lifecycle intentionally deferred.

CREATE TABLE IF NOT EXISTS infra_wallet_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  status VARCHAR(32) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'frozen', 'closed')),
  -- Projection of ledger; never invent money outside ledger_movements.
  available NUMERIC(28, 7) NOT NULL DEFAULT 0 CHECK (available >= 0),
  pending NUMERIC(28, 7) NOT NULL DEFAULT 0 CHECK (pending >= 0),
  locked NUMERIC(28, 7) NOT NULL DEFAULT 0 CHECK (locked >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, environment, asset)
);

CREATE INDEX IF NOT EXISTS idx_infra_wallet_accounts_org_env
  ON infra_wallet_accounts (org_id, environment);

CREATE TABLE IF NOT EXISTS infra_ledger_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_account_id UUID NOT NULL REFERENCES infra_wallet_accounts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  direction VARCHAR(8) NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount NUMERIC(28, 7) NOT NULL CHECK (amount > 0),
  asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
  movement_type VARCHAR(64) NOT NULL DEFAULT 'adjustment',
  reference VARCHAR(255),
  idempotency_key VARCHAR(255) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  available_after NUMERIC(28, 7) NOT NULL,
  pending_after NUMERIC(28, 7) NOT NULL,
  locked_after NUMERIC(28, 7) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_infra_ledger_wallet_created
  ON infra_ledger_movements (wallet_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_ledger_org_env_created
  ON infra_ledger_movements (org_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_infra_ledger_reference
  ON infra_ledger_movements (reference)
  WHERE reference IS NOT NULL;
