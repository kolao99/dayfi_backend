CREATE TABLE IF NOT EXISTS dayflow_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  flow_type TEXT NOT NULL DEFAULT 'mixed',
  status TEXT NOT NULL DEFAULT 'active',
  total_amount NUMERIC(18, 2) NOT NULL CHECK (total_amount >= 0),
  held_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
  spent_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN',
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  schedules JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  hold_movement_id TEXT,
  release_movement_id TEXT,
  period_label TEXT,
  budget_type TEXT NOT NULL DEFAULT 'monthly',
  summary_line TEXT,
  next_run_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dayflow_flows_user_id ON dayflow_flows (user_id);
CREATE INDEX IF NOT EXISTS idx_dayflow_flows_user_status ON dayflow_flows (user_id, status);
CREATE INDEX IF NOT EXISTS idx_dayflow_flows_next_run ON dayflow_flows (next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
