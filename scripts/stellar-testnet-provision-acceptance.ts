/**
 * CEO acceptance: provision two Dayfi users on STELLAR TESTNET via the real
 * provisionCryptoWalletsForUser path. Idempotent re-run for user 1.
 *
 * Usage (inside API container or with DAYFI_DATABASE_URL + STELLAR_NETWORK=testnet):
 *   npx ts-node -r dotenv/config scripts/stellar-testnet-provision-acceptance.ts
 */
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../src/config/database';
import { getStellarConfig } from '../src/config/stellarConfig';
import {
  estimateXlmRequiredForProvision,
  getPersistedCryptoDepositAddresses,
  isUserCryptoWalletReady,
  provisionCryptoWalletsForUser,
} from '../src/modules/payment/cryptoWalletProvision';

async function masterBalance(): Promise<number> {
  const pk = process.env.MASTER_WALLET_PUBLIC_KEY?.trim();
  if (!pk) throw new Error('MASTER_WALLET_PUBLIC_KEY missing');
  const server = new StellarSdk.Horizon.Server(getStellarConfig().horizonUrl);
  const account = await server.loadAccount(pk);
  const native = (
    account.balances as { asset_type?: string; balance?: string }[]
  ).find((b) => b.asset_type === 'native');
  return parseFloat(String(native?.balance || '0'));
}

async function ensureUser(label: string): Promise<string> {
  const phone = `+1555${Date.now().toString().slice(-8)}${label.charCodeAt(0)}`;
  const row = await db.one<{ user_id: string }>(
    `INSERT INTO users (first_name, phone_e164, status, level, phone_verified)
     VALUES ($1, $2, 'active', 'level-0', false)
     RETURNING user_id`,
    [`Testnet ${label}`, phone]
  );
  return row.user_id;
}

async function onChainSnapshot(address: string) {
  const server = new StellarSdk.Horizon.Server(getStellarConfig().horizonUrl);
  const account = await server.loadAccount(address);
  const native = (
    account.balances as { asset_type?: string; balance?: string }[]
  ).find((b) => b.asset_type === 'native');
  const trustlines = (
    account.balances as {
      asset_type?: string;
      asset_code?: string;
      asset_issuer?: string;
    }[]
  )
    .filter((b) => b.asset_type !== 'native')
    .map((b) => `${b.asset_code}:${String(b.asset_issuer).slice(0, 8)}…`);
  return {
    balance: parseFloat(String(native?.balance || '0')),
    subentry_count: Number(account.subentry_count || 0),
    num_sponsored: Number(
      (account as { num_sponsored?: number }).num_sponsored || 0
    ),
    trustlines,
  };
}

async function main() {
  const cfg = getStellarConfig();
  if (!cfg.isTestnet) {
    throw new Error(
      `Refusing to run: STELLAR_NETWORK must be testnet (got ${cfg.network})`
    );
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

  const results: unknown[] = [];

  for (const label of ['A', 'B']) {
    const before = await masterBalance();
    const userId = await ensureUser(label);
    const provisioned = await provisionCryptoWalletsForUser(userId);
    const ready = await isUserCryptoWalletReady(userId);
    const persisted = await getPersistedCryptoDepositAddresses(userId);
    const chain = await onChainSnapshot(provisioned.stellarAddress);
    const after = await masterBalance();

    // Idempotency: provision again — must return same address, no second createAccount.
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
    JSON.stringify(
      {
        results,
        masterBalanceAfter: await masterBalance(),
      },
      null,
      2
    )
  );
  await db.$pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.$pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
