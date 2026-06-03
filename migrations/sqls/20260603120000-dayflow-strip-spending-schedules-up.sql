-- One-time cleanup: remove spending-pocket schedules (Sweets, Water, Food, etc.)
-- mistakenly expanded from category-only flows. Keeps airtime, bills, family send,
-- and any schedule with recipientHint / recipientId.

CREATE OR REPLACE FUNCTION dayflow_category_needs_autopay(category_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(trim(coalesce(category_name, ''))) ~
      '(airtime|data|electric|utility|cable|dstv|gotv|internet|bill)' THEN true
    WHEN lower(trim(coalesce(category_name, ''))) ~
      '(family|support|allowance|mom|dad|rent)' THEN true
    WHEN lower(trim(coalesce(category_name, ''))) ~
      '(saving|emergency)' THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION dayflow_schedule_should_keep(schedule jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(coalesce(schedule->>'paymentType', 'send')) = 'savings' THEN true
    WHEN lower(coalesce(schedule->>'paymentType', 'send')) = 'bill' THEN true
    WHEN coalesce(trim(schedule->>'recipientHint'), '') <> '' THEN true
    WHEN coalesce(trim(schedule->>'recipientId'), '') <> '' THEN true
    WHEN dayflow_category_needs_autopay(coalesce(schedule->>'title', '')) THEN true
    ELSE false
  END;
$$;

WITH filtered AS (
  SELECT
    f.id,
    COALESCE(
      (
        SELECT jsonb_agg(elem ORDER BY ord)
        FROM jsonb_array_elements(f.schedules) WITH ORDINALITY AS t(elem, ord)
        WHERE dayflow_schedule_should_keep(elem)
      ),
      '[]'::jsonb
    ) AS new_schedules
  FROM dayflow_flows f
  WHERE f.status = 'active'
    AND jsonb_array_length(COALESCE(f.schedules, '[]'::jsonb)) > 0
),
changed AS (
  SELECT id, new_schedules
  FROM filtered
  WHERE new_schedules IS DISTINCT FROM (
    SELECT schedules FROM dayflow_flows WHERE dayflow_flows.id = filtered.id
  )
)
UPDATE dayflow_flows f
SET
  schedules = c.new_schedules,
  next_run_at = (
    SELECT MIN((elem->>'nextRunAt')::timestamptz)
    FROM jsonb_array_elements(c.new_schedules) AS elem
    WHERE coalesce(elem->>'autoPay', 'true') = 'true'
      AND coalesce(trim(elem->>'nextRunAt'), '') <> ''
  ),
  metadata = COALESCE(f.metadata, '{}'::jsonb) || jsonb_build_object(
    'strippedSpendingSchedulesAt', to_jsonb(CURRENT_TIMESTAMP)
  ),
  updated_at = CURRENT_TIMESTAMP
FROM changed c
WHERE f.id = c.id;

-- Cancel budgets linked to schedules that were removed from their flow.
UPDATE budgets b
SET
  status = 'cancelled',
  updated_at = CURRENT_TIMESTAMP
WHERE b.status NOT IN ('cancelled', 'completed')
  AND coalesce(b.metadata->>'dayflowFlowId', '') <> ''
  AND coalesce(b.metadata->>'scheduleId', '') <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM dayflow_flows f
    CROSS JOIN jsonb_array_elements(COALESCE(f.schedules, '[]'::jsonb)) AS elem
    WHERE f.id::text = b.metadata->>'dayflowFlowId'
      AND elem->>'id' = b.metadata->>'scheduleId'
  );

DROP FUNCTION IF EXISTS dayflow_schedule_should_keep(jsonb);
DROP FUNCTION IF EXISTS dayflow_category_needs_autopay(text);
