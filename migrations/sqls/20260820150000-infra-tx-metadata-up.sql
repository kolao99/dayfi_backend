-- Metadata for collection instructions / payout recipient details
ALTER TABLE infra_transactions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
