/**
 * Create (or ensure) the SendHome Dayfi org + TEST API key.
 *
 * Usage:
 *   npm run build
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/setup-sendhome-org.mjs
 *
 * Env (optional):
 *   SENDHOME_ORG_EMAIL=hello@sendhome.app
 *   SENDHOME_ORG_PASSWORD=sendhome123
 */
import bcrypt from 'bcrypt';
import { db } from '../dist/src/config/database.js';
import { createApiKey } from '../dist/src/modules/infra/infraService.js';
import { bootstrapOrgWallets } from '../dist/src/modules/infra/infraLedgerService.js';

const ORG_ID = 'b0000000-0000-4000-8000-000000000002';
const ORG_SLUG = 'sendhome';
const ORG_NAME = 'SendHome';
const MEMBER_EMAIL = (process.env.SENDHOME_ORG_EMAIL || 'hello@sendhome.app').toLowerCase();
const MEMBER_PASSWORD = process.env.SENDHOME_ORG_PASSWORD || 'sendhome123';
const MEMBER_NAME = 'SendHome Team';

async function ensureOrg() {
  const existing = await db.oneOrNone(
    `SELECT id, name, slug FROM infra_organizations WHERE slug = $1 OR id = $2`,
    [ORG_SLUG, ORG_ID]
  );
  if (existing) {
    await db.none(
      `UPDATE infra_organizations SET name = $2, slug = $3 WHERE id = $1`,
      [existing.id, ORG_NAME, ORG_SLUG]
    );
    return existing.id;
  }

  const inserted = await db.one(
    `INSERT INTO infra_organizations (id, name, slug, verification_status)
     VALUES ($1, $2, $3, 'unverified')
     RETURNING id`,
    [ORG_ID, ORG_NAME, ORG_SLUG]
  );
  return inserted.id;
}

async function ensureMember(orgId) {
  const passwordHash = await bcrypt.hash(MEMBER_PASSWORD, 10);
  const existing = await db.oneOrNone(
    `SELECT id, org_id FROM infra_members WHERE LOWER(email) = LOWER($1)`,
    [MEMBER_EMAIL]
  );

  if (existing) {
    await db.none(
      `UPDATE infra_members
       SET org_id = $1, password_hash = $2, name = $3, role = 'admin',
           first_name = 'SendHome', last_name = 'Team', account_type = 'business',
           personal_onboarding_complete = TRUE, kyc_level = 1
       WHERE id = $4`,
      [orgId, passwordHash, MEMBER_NAME, existing.id]
    );
    return existing.id;
  }

  const inserted = await db.one(
    `INSERT INTO infra_members
       (org_id, email, password_hash, name, role, first_name, last_name, account_type,
        personal_onboarding_complete, kyc_level)
     VALUES ($1, $2, $3, $4, 'admin', 'SendHome', 'Team', 'business', TRUE, 1)
     RETURNING id`,
    [orgId, MEMBER_EMAIL, passwordHash, MEMBER_NAME]
  );
  return inserted.id;
}

async function ensureApiKey(orgId, memberId) {
  const active = await db.oneOrNone(
    `SELECT id FROM infra_api_keys
     WHERE org_id = $1 AND environment = 'test' AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [orgId]
  );
  if (active && process.argv.includes('--reuse-key')) {
    console.error('Active TEST key already exists. Pass --rotate to issue a new one.');
    process.exit(1);
  }
  if (active && !process.argv.includes('--rotate')) {
    return null;
  }

  return createApiKey(orgId, 'test', 'SendHome BFF', {
    memberId,
    orgId,
    email: MEMBER_EMAIL,
    role: 'admin',
    env: 'test',
  });
}

const orgId = await ensureOrg();
const memberId = await ensureMember(orgId);
await bootstrapOrgWallets(orgId);

const key = await ensureApiKey(orgId, memberId);

console.log(
  JSON.stringify(
    {
      orgId,
      orgName: ORG_NAME,
      orgSlug: ORG_SLUG,
      dashboardEmail: MEMBER_EMAIL,
      dashboardPassword: MEMBER_PASSWORD,
      dashboardUrl: 'http://localhost:5173/dashboard',
      apiKey: key?.secret || null,
      apiKeyNote: key ? 'new key issued' : 'reuse existing key in sendhome/.env or pass --rotate',
    },
    null,
    2
  )
);

if (key?.secret) {
  console.log('\n' + key.secret);
}

await db.$pool.end();
