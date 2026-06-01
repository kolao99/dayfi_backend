CREATE TABLE IF NOT EXISTS dayflow_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'My Plan',
  budget_type TEXT NOT NULL DEFAULT 'monthly',
  period_label TEXT NOT NULL DEFAULT 'This Month',
  total_budget NUMERIC(18, 2) NOT NULL DEFAULT 0,
  spent_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN',
  summary_line TEXT,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  upcoming JSONB NOT NULL DEFAULT '[]'::jsonb,
  goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  locked_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  sweep_to_dayearn BOOLEAN NOT NULL DEFAULT false,
  leftover NUMERIC(18, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS dayflow_plans_user_active_idx
  ON dayflow_plans (user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS dayflow_plans_user_id_idx ON dayflow_plans (user_id);
