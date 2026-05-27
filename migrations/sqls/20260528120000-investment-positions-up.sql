-- Locked investment positions with maturity yield.
CREATE TABLE IF NOT EXISTS investment_positions (
  id VARCHAR PRIMARY KEY DEFAULT 'invp-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', '')),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  principal NUMERIC(15, 2) NOT NULL CHECK (principal > 0),
  apy_percent NUMERIC(6, 3) NOT NULL CHECK (apy_percent > 0 AND apy_percent <= 100),
  lock_days INT NOT NULL CHECK (lock_days > 0),
  interest_earned NUMERIC(15, 4) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'matured', 'claimed')),
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matures_at TIMESTAMP NOT NULL,
  claimed_at TIMESTAMP,
  deposit_reference VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_investment_positions_user
  ON investment_positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_investment_positions_matures
  ON investment_positions(matures_at) WHERE status IN ('active', 'matured');

ALTER TABLE investment_movements
  ADD COLUMN IF NOT EXISTS position_id VARCHAR REFERENCES investment_positions(id);
