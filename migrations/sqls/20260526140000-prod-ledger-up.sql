CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Idempotent ledger audit trail (all USD credits/debits).
CREATE TABLE IF NOT EXISTS ledger_movements (
  id VARCHAR PRIMARY KEY DEFAULT 'lm-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', '')),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  wallet_id VARCHAR NOT NULL REFERENCES wallets(wallet_id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  usd_equivalent NUMERIC(15, 2) NOT NULL,
  source VARCHAR(50) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  external_reference VARCHAR(255),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_movements_user ON ledger_movements(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_movements_external_ref ON ledger_movements(external_reference);

-- Investment pocket (yield account) — balance in USD.
CREATE TABLE IF NOT EXISTS investment_pockets (
  user_id VARCHAR PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  balance NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
  total_deposited NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  total_withdrawn NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  risk_accepted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS investment_movements (
  id VARCHAR PRIMARY KEY DEFAULT 'inv-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', '')),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- P2P transfers (Dayfi tag → Dayfi tag, USD).
CREATE TABLE IF NOT EXISTS p2p_transfers (
  id VARCHAR PRIMARY KEY DEFAULT 'p2p-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', '')),
  reference VARCHAR(255) NOT NULL UNIQUE,
  sender_user_id VARCHAR NOT NULL REFERENCES users(user_id),
  recipient_user_id VARCHAR NOT NULL REFERENCES users(user_id),
  amount_usd NUMERIC(15, 2) NOT NULL CHECK (amount_usd > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_p2p_transfers_sender ON p2p_transfers(sender_user_id, created_at DESC);
