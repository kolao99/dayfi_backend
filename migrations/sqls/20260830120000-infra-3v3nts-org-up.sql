-- Dedicated 3v3nts merchant org (first platform user on Dayfi).
INSERT INTO infra_organizations (id, name, slug, verification_status)
VALUES ('b0000000-0000-4000-8000-000000000001', '3v3nts', '3v3nts', 'unverified')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO infra_members (
  org_id, email, password_hash, name, role, first_name, last_name, account_type,
  personal_onboarding_complete, kyc_level
)
SELECT
  'b0000000-0000-4000-8000-000000000001',
  'hello@3v3nts.com',
  '$2b$10$0vE.QmGsGF2a4RbDYBGir.ZQ3lYKgqxF1pWBKFGuGCBeTkU7CaQ7K',
  '3v3nts Team',
  'admin',
  '3v3nts',
  'Team',
  'business',
  TRUE,
  1
WHERE NOT EXISTS (
  SELECT 1 FROM infra_members WHERE LOWER(email) = LOWER('hello@3v3nts.com')
);

UPDATE infra_members
SET org_id = 'b0000000-0000-4000-8000-000000000001',
    password_hash = '$2b$10$0vE.QmGsGF2a4RbDYBGir.ZQ3lYKgqxF1pWBKFGuGCBeTkU7CaQ7K',
    name = '3v3nts Team',
    role = 'admin',
    first_name = '3v3nts',
    last_name = 'Team',
    account_type = 'business',
    personal_onboarding_complete = TRUE,
    kyc_level = 1
WHERE LOWER(email) = LOWER('hello@3v3nts.com');

INSERT INTO infra_wallet_accounts (org_id, environment, asset, status)
SELECT 'b0000000-0000-4000-8000-000000000001', 'test', 'USDC', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM infra_wallet_accounts
  WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
    AND environment = 'test'
    AND asset = 'USDC'
);
