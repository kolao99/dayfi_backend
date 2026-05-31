CREATE TABLE IF NOT EXISTS dayearn_pots (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('NGN', 'USD', 'EUR', 'GBP')),
  principal NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (principal >= 0),
  interest_earned NUMERIC(15, 4) NOT NULL DEFAULT 0,
  apy_percent NUMERIC(6, 3) NOT NULL,
  accrual_starts_at TIMESTAMP NOT NULL,
  last_interest_at TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dayearn_pots_user_status
  ON dayearn_pots (user_id, status);

CREATE TABLE IF NOT EXISTS dayearn_movements (
  id VARCHAR(64) PRIMARY KEY,
  pot_id VARCHAR(64) NOT NULL REFERENCES dayearn_pots(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  movement_type VARCHAR(20) NOT NULL CHECK (movement_type IN ('deposit', 'withdraw', 'interest')),
  amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL,
  idempotency_key VARCHAR(128) UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dayearn_movements_pot_created
  ON dayearn_movements (pot_id, created_at DESC);
