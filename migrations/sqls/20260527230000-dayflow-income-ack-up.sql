CREATE TABLE IF NOT EXISTS dayflow_income_ack (
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  transaction_id VARCHAR(128) NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_dayflow_income_ack_user
  ON dayflow_income_ack (user_id, acknowledged_at DESC);
