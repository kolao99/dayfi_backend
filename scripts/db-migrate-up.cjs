/**
 * Runs db-migrate up. If DAYFI_DATABASE_URL is unset but DATABASE_URL is set
 * (typical on Heroku / Render / Railway), copies it so database.json resolves.
 */
require('dotenv').config();
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const d = String(process.env.DAYFI_DATABASE_URL || '').trim();
const fallback = String(process.env.DATABASE_URL || '').trim();
if (!d && fallback) {
  process.env.DAYFI_DATABASE_URL = fallback;
}

const bin = path.join(__dirname, '..', 'node_modules', 'db-migrate', 'bin', 'db-migrate');
const r = spawnSync(process.execPath, ['-r', 'dotenv/config', bin, 'up', '--config', 'database.json'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: process.env,
});
process.exit(r.status === null ? 1 : r.status);
