-- SendHome consumer remittance org on Dayfi infra.
INSERT INTO infra_organizations (id, name, slug, verification_status)
VALUES ('b0000000-0000-4000-8000-000000000002', 'SendHome', 'sendhome', 'unverified')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO infra_members (
  org_id, email, password_hash, name, role, first_name, last_name, account_type,
  personal_onboarding_complete, kyc_level
)
SELECT
  'b0000000-0000-4000-8000-000000000002',
  'hello@sendhome.app',
  '$2b$10$0vE.QmGsGF2a4RbDYBGir.ZQ3lYKgqxF1pWBKFGuGCBeTkU7CaQ7K',
  'SendHome Team',
  'admin',
  'SendHome',
  'Team',
  'business',
  TRUE,
  1
WHERE NOT EXISTS (
  SELECT 1 FROM infra_members WHERE LOWER(email) = LOWER('hello@sendhome.app')
);

UPDATE infra_members
SET org_id = 'b0000000-0000-4000-8000-000000000002',
    password_hash = '$2b$10$0vE.QmGsGF2a4RbDYBGir.ZQ3lYKgqxF1pWBKFGuGCBeTkU7CaQ7K',
    name = 'SendHome Team',
    role = 'admin',
    first_name = 'SendHome',
    last_name = 'Team',
    account_type = 'business',
    personal_onboarding_complete = TRUE,
    kyc_level = 1
WHERE LOWER(email) = LOWER('hello@sendhome.app');

INSERT INTO infra_wallet_accounts (org_id, environment, asset, status)
SELECT 'b0000000-0000-4000-8000-000000000002', 'test', 'USDC', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM infra_wallet_accounts
  WHERE org_id = 'b0000000-0000-4000-8000-000000000002'
    AND environment = 'test'
    AND asset = 'USDC'
);
