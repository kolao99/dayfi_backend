/**
 * Wipes users and related app data for a clean signup test.
 *
 * Local:
 *   npm run db:clear-users
 *
 * Railway (destructive — all users on that DB):
 *   CONFIRM_RAILWAY_CLEAR=yes DAYFI_DATABASE_URL='postgresql://...' npm run db:clear-users
 *
 * Or after `railway login` && `railway link`:
 *   CONFIRM_RAILWAY_CLEAR=yes railway run npm run db:clear-users
 */
import { db } from '../src/config/database';

function resolveConnectionString(): string {
  const url =
    process.env.DAYFI_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    '';
  if (!url) {
    throw new Error(
      'Set DAYFI_DATABASE_URL or DATABASE_URL (Railway: copy from Postgres → Connect)'
    );
  }
  return url;
}

function isRailwayHost(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('railway.app') ||
    u.includes('rlwy.net') ||
    u.includes('railway.internal')
  );
}

async function main() {
  const connectionString = resolveConnectionString();
  const onRailway = isRailwayHost(connectionString);

  if (onRailway && process.env.CONFIRM_RAILWAY_CLEAR !== 'yes') {
    console.error(
      'Refusing to clear a Railway database without CONFIRM_RAILWAY_CLEAR=yes'
    );
    console.error(
      'Example: CONFIRM_RAILWAY_CLEAR=yes DAYFI_DATABASE_URL="postgresql://..." npm run db:clear-users'
    );
    process.exit(1);
  }

  const hostHint = connectionString.replace(/:[^:@]+@/, ':***@');
  console.log(`Clearing users and related data on: ${hostHint}`);
  if (onRailway) {
    console.log('⚠️  RAILWAY / PRODUCTION DATABASE');
  }

  const tables = [
    'investment_movements',
    'investment_pockets',
    'ledger_movements',
    'p2p_transfers',
    'wallet_transactions',
    'source',
    'beneficiaries',
    'grey_virtual_accounts',
    'wallets',
    'wallet_currency_swaps',
    'blacklisted_jwt_tokens',
    'users',
  ];

  for (const table of tables) {
    try {
      await db.none(`DELETE FROM ${table}`);
      console.log(`  cleared ${table}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('does not exist')) {
        console.log(`  skip ${table} (missing)`);
      } else {
        throw e;
      }
    }
  }

  const userCount = await db.oneOrNone<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM users'
  );
  console.log(`  users remaining: ${userCount?.n ?? '?'}`);
  console.log('Done. You can sign up fresh on this database.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
