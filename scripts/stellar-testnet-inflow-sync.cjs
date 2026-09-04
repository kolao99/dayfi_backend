/**
 * Sync Stellar testnet USDC inflows for a Dayfi user and print ledger balances.
 * node -r dotenv/config scripts/stellar-testnet-inflow-sync.cjs <userId>
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { db } = require('../dist/src/config/database');
const { getStellarConfig } = require('../dist/src/config/stellarConfig');
const {
  syncStellarInflowsToLedger,
} = require('../dist/src/modules/payment/cryptoInflowSyncService');

async function main() {
  const userId = process.argv[2];
  if (!userId) throw new Error('Usage: node ... <userId>');
  const cfg = getStellarConfig();
  if (!cfg.isTestnet) throw new Error(`Refusing: network=${cfg.network}`);

  const wallets = await db.any(
    `SELECT wallet_id, currency, balance, stellar_deposit_address, ethereum_deposit_address
     FROM wallets WHERE user_id = $1`,
    [userId]
  );
  const walletsByCurrency = {};
  for (const w of wallets) {
    walletsByCurrency[w.currency] = w;
  }

  const before = wallets.map((w) => ({
    currency: w.currency,
    balance: w.balance,
    stellar: w.stellar_deposit_address,
  }));

  const sync = await syncStellarInflowsToLedger({ userId, walletsByCurrency });

  const after = await db.any(
    `SELECT currency, balance FROM wallets WHERE user_id = $1 ORDER BY currency`,
    [userId]
  );
  console.log(
    JSON.stringify({ network: cfg.network, userId, before, sync, after }, null, 2)
  );
  await db.$pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await db.$pool.end();
  } catch (_) {}
  process.exit(1);
});
