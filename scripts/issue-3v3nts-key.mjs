/**
 * Issue a TEST API key for the dedicated 3v3nts Dayfi org.
 * Creates the org first if missing.
 *
 * Usage: node -r dotenv/config scripts/issue-3v3nts-key.mjs [--rotate]
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../dist/src/config/database.js';
import { createApiKey } from '../dist/src/modules/infra/infraService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rotate = process.argv.includes('--rotate');

let orgRow = await db.oneOrNone(
  `SELECT o.id, m.id AS member_id, m.email
   FROM infra_organizations o
   JOIN infra_members m ON m.org_id = o.id
   WHERE o.slug = '3v3nts'
   ORDER BY m.created_at ASC
   LIMIT 1`
);

if (!orgRow) {
  const setup = spawnSync(
    'node',
    ['-r', 'dotenv/config', 'scripts/setup-3v3nts-org.mjs', ...(rotate ? ['--rotate'] : [])],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
      env: process.env,
    }
  );
  if (setup.status !== 0) {
    console.error(setup.stdout || 'setup-3v3nts-org failed');
    process.exit(1);
  }
  const secret = setup.stdout.trim().split('\n').pop();
  if (secret?.startsWith('sk_test_')) {
    console.log(secret);
    await db.$pool.end();
    process.exit(0);
  }
  orgRow = await db.oneOrNone(
    `SELECT o.id, m.id AS member_id, m.email
     FROM infra_organizations o
     JOIN infra_members m ON m.org_id = o.id
     WHERE o.slug = '3v3nts'
     LIMIT 1`
  );
}

if (!orgRow) {
  console.error('3v3nts org not found after setup.');
  process.exit(1);
}

if (!rotate) {
  const existing = await db.oneOrNone(
    `SELECT id FROM infra_api_keys
     WHERE org_id = $1 AND environment = 'test' AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [orgRow.id]
  );
  if (existing) {
    console.error(
      'Active TEST key already exists for 3v3nts. Use --rotate to issue a new one, or copy from Dayfi dashboard.'
    );
    process.exit(1);
  }
}

const created = await createApiKey(orgRow.id, 'test', '3v3nts local', {
  memberId: orgRow.member_id,
  orgId: orgRow.id,
  email: orgRow.email,
  role: 'owner',
  env: 'test',
});

console.log(created.secret);
await db.$pool.end();
