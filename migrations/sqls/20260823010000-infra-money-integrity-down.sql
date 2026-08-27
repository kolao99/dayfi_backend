DROP INDEX IF EXISTS idx_infra_tx_org_env_idempotency;

ALTER TABLE infra_transactions
  DROP COLUMN IF EXISTS request_fingerprint,
  DROP COLUMN IF EXISTS client_idempotency_key;

ALTER TABLE infra_transactions
  ALTER COLUMN amount TYPE BIGINT USING ROUND(amount)::bigint,
  ALTER COLUMN fee TYPE BIGINT USING ROUND(fee)::bigint;
