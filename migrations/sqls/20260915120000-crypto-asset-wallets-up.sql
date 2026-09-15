CREATE TABLE IF NOT EXISTS crypto_asset_wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  asset VARCHAR(16) NOT NULL,
  network VARCHAR(32) NOT NULL,
  address VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'FAILED', 'SUSPENDED')),
  provider VARCHAR(32) NOT NULL DEFAULT 'dayfi',
  custody VARCHAR(32) NOT NULL DEFAULT 'dayfi_ledger',
  trustline_ready BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, asset, network)
);

CREATE INDEX IF NOT EXISTS idx_crypto_asset_wallets_user
  ON crypto_asset_wallets (user_id);

CREATE INDEX IF NOT EXISTS idx_crypto_asset_wallets_status
  ON crypto_asset_wallets (status);
