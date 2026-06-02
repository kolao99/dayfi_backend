CREATE TABLE IF NOT EXISTS dayflow_plan_templates (
  user_id VARCHAR PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  template JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS dayflow_plan_templates_updated_idx
  ON dayflow_plan_templates (updated_at DESC);
