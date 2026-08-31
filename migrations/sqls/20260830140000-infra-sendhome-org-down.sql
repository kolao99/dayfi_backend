DELETE FROM infra_wallet_accounts
WHERE org_id = 'b0000000-0000-4000-8000-000000000002';

DELETE FROM infra_members
WHERE LOWER(email) = LOWER('hello@sendhome.app');

DELETE FROM infra_organizations
WHERE slug = 'sendhome';
