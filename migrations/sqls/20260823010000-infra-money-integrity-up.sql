-- P1 money integrity: decimal amounts + create-time Idempotency-Key.

ALTER TABLE infra_transactions
  ALTER COLUMN amount TYPE NUMERIC(28, 7) USING amount::numeric,
  ALTER COLUMN fee TYPE NUMERIC(28, 7) USING fee::numeric;

ALTER TABLE infra_transactions
  ADD COLUMN IF NOT EXISTS client_idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_tx_org_env_idempotency
  ON infra_transactions (org_id, environment, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
