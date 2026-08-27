-- Phase 4: bulk batch orchestration.
-- Parent batch never touches the ledger — only child payouts (Phase 2) do.

CREATE TABLE IF NOT EXISTS infra_bulk_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test', 'live')),
  batch_code VARCHAR(32) NOT NULL,
  label VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'validating',
      'ready',
      'processing',
      'partially_completed',
      'completed',
      'failed',
      'cancelled'
    )),
  source VARCHAR(32) NOT NULL DEFAULT 'api'
    CHECK (source IN ('api', 'csv', 'recipients')),
  currency VARCHAR(16) NOT NULL DEFAULT 'USDC',
  item_count INTEGER NOT NULL DEFAULT 0,
  -- Quoted at preflight (USDC settlement units)
  total_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  fee_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  -- Aggregated from child payout outcomes (refreshed)
  completed_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  released_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  locked_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  processing_count INTEGER NOT NULL DEFAULT 0,
  preflight JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, batch_code)
);

CREATE INDEX IF NOT EXISTS idx_infra_bulk_batches_org_env
  ON infra_bulk_batches (org_id, environment, created_at DESC);

CREATE TABLE IF NOT EXISTS infra_bulk_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id UUID NOT NULL REFERENCES infra_bulk_batches(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES infra_organizations(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  recipient_id UUID REFERENCES infra_recipients(id) ON DELETE SET NULL,
  destination_id UUID REFERENCES infra_recipient_destinations(id) ON DELETE SET NULL,
  amount NUMERIC(20, 7) NOT NULL,
  currency VARCHAR(16) NOT NULL,
  usdc_amount NUMERIC(20, 7),
  fee_usdc NUMERIC(20, 7) NOT NULL DEFAULT 0,
  fx_rate NUMERIC(20, 10),
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'invalid',
      'ready',
      'processing',
      'completed',
      'failed',
      'cancelled',
      'skipped'
    )),
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Child payout created on confirm (Phase 2 lifecycle owns money)
  payout_transaction_id UUID REFERENCES infra_transactions(id) ON DELETE SET NULL,
  instruction JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_infra_bulk_items_batch
  ON infra_bulk_items (batch_id, line_number);

CREATE INDEX IF NOT EXISTS idx_infra_bulk_items_payout
  ON infra_bulk_items (payout_transaction_id)
  WHERE payout_transaction_id IS NOT NULL;
