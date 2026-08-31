/**
 * Waits until DAYFI_DATABASE_URL accepts connections (Docker Postgres may need a few seconds after `up -d`).
 * Logs current_user / is_superuser so you can spot connecting to the wrong server (e.g. local :5432 vs Docker :5433).
 */
const { Client } = require('pg');
const path = require('node:path');

require('dotenv').config();
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.local'),
  override: true,
});

let url = (process.env.DAYFI_DATABASE_URL || process.env.DATABASE_URL || '').trim();
// docker env_file / dotenv may leave surrounding quotes
if (
  (url.startsWith('"') && url.endsWith('"')) ||
  (url.startsWith("'") && url.endsWith("'"))
) {
  url = url.slice(1, -1);
}
if (!url) {
  console.error('Set DAYFI_DATABASE_URL in .env');
  process.exit(1);
}
if (url.includes('railway.internal') && !process.env.RAILWAY_ENVIRONMENT) {
  console.error(
    'DAYFI_DATABASE_URL uses railway.internal — that only works on Railway. Use the public *.railway.app URL from Postgres → Connect → Public networking.'
  );
  process.exit(1);
}

function useSsl(connectionUrl) {
  try {
    const u = new URL(connectionUrl);
    const host = u.hostname;
    const sslmode = u.searchParams.get('sslmode');
    if (sslmode === 'disable' || sslmode === 'no-verify') return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'postgres') {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

const deadline = Date.now() + 90000;

async function main() {
  while (Date.now() < deadline) {
    const c = new Client({
      connectionString: url,
      connectionTimeoutMillis: 5000,
      ...(useSsl(url) ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    try {
      await c.connect();
      const r = await c.query(
        `SELECT current_user,
                current_database(),
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`
      );
      const row = r.rows[0];
      console.log(
        `Postgres ready: user=${row.current_user} db=${row.current_database} superuser=${row.is_superuser}`
      );
      if (!row.is_superuser) {
        console.warn(
          'This role is not a superuser; first migrations (CREATE EXTENSION) need a superuser or use Docker Postgres on host port 5433.'
        );
      }
      await c.end();
      process.exit(0);
    } catch (e) {
      console.error('Waiting for Postgres...', e.message);
      try {
        await c.end();
      } catch (_) {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  console.error('Timed out waiting for Postgres at', url.replace(/:[^:@/]+@/, ':****@'));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
