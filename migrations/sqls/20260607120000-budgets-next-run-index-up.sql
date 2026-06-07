CREATE INDEX IF NOT EXISTS idx_budgets_next_run_active
  ON budgets (next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
