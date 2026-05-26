/**
 * Wipes app users and payment data for a clean signup test.
 * Usage: npx ts-node -r dotenv/config scripts/clear-test-users.ts
 */
import { db } from '../src/config/database';

async function main() {
  console.log('Clearing users and related payment data…');

  const tables = [
    'ledger_movements',
    'p2p_transfers',
    'wallet_transactions',
    'grey_virtual_accounts',
    'investment_positions',
    'wallets',
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

  console.log('Done. You can sign up fresh.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
