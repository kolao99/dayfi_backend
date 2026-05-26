-- Unified USD ledger: backfill USD wallets; store Grey virtual account metadata (table renamed in 20260526150000).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

INSERT INTO wallets (user_id, balance, wallet_reference, currency, provider, created_at, updated_at)
SELECT
  u.user_id,
  0.00,
  'usd-migrate-' || u.user_id || '-' || floor(extract(epoch FROM now()))::text,
  'USD',
  'platform',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM wallets w
  WHERE w.user_id = u.user_id AND w.currency = 'USD'
);

INSERT INTO wallets (user_id, balance, wallet_reference, currency, provider, created_at, updated_at)
SELECT
  u.user_id,
  0.00,
  'ngn-migrate-' || u.user_id || '-' || floor(extract(epoch FROM now()))::text,
  'NGN',
  'platform',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM wallets w
  WHERE w.user_id = u.user_id AND w.currency = 'NGN'
);

CREATE TABLE IF NOT EXISTS grey_virtual_accounts (
  id VARCHAR PRIMARY KEY DEFAULT 'fva-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', '')),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  currency VARCHAR(10) NOT NULL,
  account_name VARCHAR(255),
  account_number VARCHAR(64),
  bank_name VARCHAR(255),
  iban VARCHAR(64),
  routing_number VARCHAR(32),
  provider_reference VARCHAR(255),
  raw_metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_grey_virtual_accounts_user ON grey_virtual_accounts(user_id);
