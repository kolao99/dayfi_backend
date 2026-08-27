/**
 * Runs db-migrate up. If DAYFI_DATABASE_URL is unset but DATABASE_URL is set
 * (typical on Heroku / Render / Railway), copies it so database.json resolves.
 */
require('dotenv').config();
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env.local'), override: true });
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const d = String(process.env.DAYFI_DATABASE_URL || '').trim();
const fallback = String(process.env.DATABASE_URL || '').trim();
if (!d && fallback) {
  process.env.DAYFI_DATABASE_URL = fallback;
}

const migDir = path.join(__dirname, '..', 'migrations');
let migCount = 0;
try {
  migCount = fs.readdirSync(migDir).filter((f) => /^\d+.*\.js$/.test(f)).length;
} catch (_) {
  /* migrations dir missing in odd layouts */
}
console.log(
  `[migrate] db-migrate up (${migCount} migration files in migrations/) — pending changes will be applied; up-to-date DBs log "No migrations to run".`
);

const bin = path.join(__dirname, '..', 'node_modules', 'db-migrate', 'bin', 'db-migrate');
const args = ['-r', 'dotenv/config', bin, 'up', '--config', 'database.json'];
if (process.env.RAILWAY_ENVIRONMENT) {
  args.push('-e', 'production');
}

const childEnv = { ...process.env };
if (process.env.RAILWAY_ENVIRONMENT) {
  childEnv.NODE_ENV = 'production';
}

const r = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: childEnv,
});
process.exit(r.status === null ? 1 : r.status);
