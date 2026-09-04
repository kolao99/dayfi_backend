/**
 * CEO acceptance (plain CJS for API container): provision two users on TESTNET.
 * node -r dotenv/config scripts/stellar-testnet-provision-acceptance.cjs
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const StellarSdk = require('@stellar/stellar-sdk');
const { db } = require('../dist/src/config/database');
const { getStellarConfig } = require('../dist/src/config/stellarConfig');
const {
  estimateXlmRequiredForProvision,
  getPersistedCryptoDepositAddresses,
  isUserCryptoWalletReady,
  provisionCryptoWalletsForUser,
} = require('../dist/src/modules/payment/cryptoWalletProvision');

async function masterBalance() {
  const pk = process.env.MASTER_WALLET_PUBLIC_KEY?.trim();
  if (!pk) throw new Error('MASTER_WALLET_PUBLIC_KEY missing');
  const server = new StellarSdk.Horizon.Server(getStellarConfig().horizonUrl);
  const account = await server.loadAccount(pk);
  const native = account.balances.find((b) => b.asset_type === 'native');
  return parseFloat(String(native?.balance || '0'));
}

async function ensureUser(label) {
  const phone = `+1555${Date.now().toString().slice(-8)}${label.charCodeAt(0)}`;
  const row = await db.one(
    `INSERT INTO users (first_name, phone_e164, status, level, phone_verified)
     VALUES ($1, $2, 'active', 'level-0', false)
     RETURNING user_id`,
    [`Testnet ${label}`, phone]
  );
  return row.user_id;
}

async function onChainSnapshot(address) {
  const server = new StellarSdk.Horizon.Server(getStellarConfig().horizonUrl);
  const account = await server.loadAccount(address);
  const native = account.balances.find((b) => b.asset_type === 'native');
  const trustlines = account.balances
    .filter((b) => b.asset_type !== 'native')
    .map((b) => `${b.asset_code}`);
  return {
    balance: parseFloat(String(native?.balance || '0')),
    subentry_count: Number(account.subentry_count || 0),
    num_sponsored: Number(account.num_sponsored || 0),
    trustlines,
  };
}

async function main() {
  const cfg = getStellarConfig();
  if (!cfg.isTestnet) {
    throw new Error(`Refusing: network=${cfg.network}`);
  }

  console.log(
    JSON.stringify(
      {
        network: cfg.network,
        horizon: cfg.horizonUrl,
        fundingGate: estimateXlmRequiredForProvision(),
        masterPublicKey: process.env.MASTER_WALLET_PUBLIC_KEY,
        masterBalanceBefore: await masterBalance(),
      },
      null,
      2
    )
  );

  const results = [];
  for (const label of ['A', 'B']) {
    const before = await masterBalance();
    const userId = await ensureUser(label);
    const provisioned = await provisionCryptoWalletsForUser(userId);
    const ready = await isUserCryptoWalletReady(userId);
    const persisted = await getPersistedCryptoDepositAddresses(userId);
    const chain = await onChainSnapshot(provisioned.stellarAddress);
    const after = await masterBalance();
    const again = await provisionCryptoWalletsForUser(userId);
    const afterIdem = await masterBalance();
    results.push({
      label,
      userId,
      stellarAddress: provisioned.stellarAddress,
      ethereumAddress: provisioned.ethereumAddress,
      persistedMatches: persisted.stellar === provisioned.stellarAddress,
      ready,
      onChain: chain,
      masterDelta: Number((before - after).toFixed(7)),
      idempotentSameAddress: again.stellarAddress === provisioned.stellarAddress,
      masterDeltaOnIdempotentRetry: Number((after - afterIdem).toFixed(7)),
    });
  }

  console.log(
    JSON.stringify({ results, masterBalanceAfter: await masterBalance() }, null, 2)
  );
  await db.$pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.$pool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
