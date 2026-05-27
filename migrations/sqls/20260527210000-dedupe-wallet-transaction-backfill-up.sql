-- Remove duplicate wallet_transactions from mismatched backfill ids / missing beneficiaries.
DELETE FROM wallet_transactions wt
WHERE wt.external_reference IS NOT NULL
  AND (
    (
      wt.beneficiary_id IS NULL
      AND EXISTS (
        SELECT 1 FROM wallet_transactions other
        WHERE other.user_id = wt.user_id
          AND other.external_reference = wt.external_reference
          AND other.id <> wt.id
          AND other.beneficiary_id IS NOT NULL
      )
    )
    OR (
      wt.id LIKE '%:%'
      AND EXISTS (
        SELECT 1 FROM wallet_transactions other
        WHERE other.user_id = wt.user_id
          AND other.external_reference = wt.external_reference
          AND other.id <> wt.id
          AND other.id NOT LIKE '%:%'
      )
    )
  );

-- Attach Wallet Top Up beneficiary to surviving ledger deposit rows missing one.
INSERT INTO beneficiaries (id, user_id, name, country, phone, address, dob, email, id_number, id_type)
SELECT
  'ben-act-' || LEFT(wt.id, 40),
  wt.user_id,
  'Wallet Top Up',
  'NG', '', '', '', '', '', 'individual'
FROM wallet_transactions wt
WHERE wt.activity_kind = 'deposit'
  AND wt.beneficiary_id IS NULL
  AND wt.receive_amount IS NOT NULL
ON CONFLICT (id) DO NOTHING;

UPDATE wallet_transactions wt
SET beneficiary_id = 'ben-act-' || LEFT(wt.id, 40)
WHERE wt.activity_kind = 'deposit'
  AND wt.beneficiary_id IS NULL
  AND wt.receive_amount IS NOT NULL;

-- Use original ledger timestamps instead of API backfill "now".
UPDATE wallet_transactions wt
SET timestamp = lm.created_at
FROM ledger_movements lm
WHERE wt.external_reference IS NOT NULL
  AND wt.external_reference = lm.external_reference
  AND wt.user_id = lm.user_id
  AND lm.direction = 'credit';
