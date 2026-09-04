/**
 * TESTNET-ONLY: measure exact XLM economics of Azap/Dayfi crypto wallet provisioning.
 *
 * Mirrors production ops in cryptoWalletProvision.ts:
 *   1) createAccount(startingBalance = FUNDING)
 *   2) sponsored changeTrust for USDC + EURC (master pays base-reserve liability)
 *
 * Does NOT touch mainnet. Does NOT use production master keys.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/stellar-provision-xlm-audit.ts
 */
import StellarSdk from '@stellar/stellar-sdk';
import {
  TESTNET_EURC_ISSUER,
  TESTNET_USDC_ISSUER,
} from '../src/config/stellarIssuers';

const HORIZON = 'https://horizon-testnet.stellar.org';
const PASSPHRASE = StellarSdk.Networks.TESTNET;
const FRIENDBOT = 'https://friendbot.stellar.org';
const BASE_RESERVE = 0.5;
const FUNDING_CANDIDATES = [1.5, 1.0] as const;

type BalSnapshot = {
  balance: number;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  minReserve: number;
  available: number;
};

async function friendbot(publicKey: string): Promise<void> {
  const res = await fetch(
    `${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Friendbot failed (${res.status}): ${body.slice(0, 200)}`);
  }
  await sleep(2500);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function loadNative(server: StellarSdk.Horizon.Server, pk: string) {
  const account = await server.loadAccount(pk);
  const native = (
    account.balances as { asset_type?: string; balance?: string }[]
  ).find((b) => b.asset_type === 'native');
  const balance = parseFloat(String(native?.balance || '0'));
  const subentryCount = Number(account.subentry_count || 0);
  const numSponsoring = Number(
    (account as { num_sponsoring?: number }).num_sponsoring || 0
  );
  const numSponsored = Number(
    (account as { num_sponsored?: number }).num_sponsored || 0
  );
  // Protocol: (2 + subentries + num_sponsoring - num_sponsored) * base_reserve
  const minReserve =
    (2 + subentryCount + numSponsoring - numSponsored) * BASE_RESERVE;
  return {
    balance,
    subentryCount,
    numSponsoring,
    numSponsored,
    minReserve,
    available: Math.max(0, balance - minReserve),
    account,
  } satisfies BalSnapshot & { account: Awaited<ReturnType<typeof server.loadAccount>> };
}

function estimateCodeGate(funding: number, trustlineCount: number): number {
  // Exact formula from estimateXlmRequiredForProvision()
  const sponsorReserves = trustlineCount * BASE_RESERVE;
  const fees = 0.05;
  return funding + sponsorReserves + BASE_RESERVE + fees;
}

async function createAccountFromMaster(
  server: StellarSdk.Horizon.Server,
  master: StellarSdk.Keypair,
  userPk: string,
  funding: string
): Promise<{ hash: string; feeCharged: string }> {
  const masterAccount = await server.loadAccount(master.publicKey());
  const tx = new StellarSdk.TransactionBuilder(masterAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.createAccount({
        destination: userPk,
        startingBalance: funding,
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(master);
  const result = await server.submitTransaction(tx);
  return {
    hash: String(result.hash),
    feeCharged: String(
      (result as { fee_charged?: string }).fee_charged ?? 'unknown'
    ),
  };
}

async function sponsoredTrustline(
  server: StellarSdk.Horizon.Server,
  master: StellarSdk.Keypair,
  user: StellarSdk.Keypair,
  asset: StellarSdk.Asset
): Promise<{ hash: string; feeCharged: string }> {
  const masterAccount = await server.loadAccount(master.publicKey());
  const fee = String(Number(StellarSdk.BASE_FEE) * 3);
  const tx = new StellarSdk.TransactionBuilder(masterAccount, {
    fee,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.beginSponsoringFutureReserves({
        sponsoredId: user.publicKey(),
      })
    )
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: '10000000',
        source: user.publicKey(),
      })
    )
    .addOperation(
      StellarSdk.Operation.endSponsoringFutureReserves({
        source: user.publicKey(),
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(master);
  tx.sign(user);
  try {
    const result = await server.submitTransaction(tx);
    return {
      hash: String(result.hash),
      feeCharged: String(
        (result as { fee_charged?: string }).fee_charged ?? 'unknown'
      ),
    };
  } catch (err: unknown) {
    const e = err as {
      response?: { data?: { extras?: unknown } };
    };
    throw new Error(
      `sponsoredTrustline(${asset.getCode()}) failed: ${JSON.stringify(e?.response?.data?.extras ?? String(err))}`
    );
  }
}

async function provisionOne(
  server: StellarSdk.Horizon.Server,
  master: StellarSdk.Keypair,
  funding: string,
  label: string
) {
  const user = StellarSdk.Keypair.random();
  const masterBefore = await loadNative(server, master.publicKey());

  const create = await createAccountFromMaster(
    server,
    master,
    user.publicKey(),
    funding
  );
  await sleep(2000);

  const afterCreateMaster = await loadNative(server, master.publicKey());
  const afterCreateUser = await loadNative(server, user.publicKey());

  const usdc = new StellarSdk.Asset('USDC', TESTNET_USDC_ISSUER);
  const eurc = new StellarSdk.Asset('EURC', TESTNET_EURC_ISSUER);

  const tl1 = await sponsoredTrustline(server, master, user, usdc);
  await sleep(1000);
  const tl2 = await sponsoredTrustline(server, master, user, eurc);
  await sleep(2000);

  const masterAfter = await loadNative(server, master.publicKey());
  const userAfter = await loadNative(server, user.publicKey());

  const masterDelta = masterBefore.balance - masterAfter.balance;
  const masterAvailableDelta =
    masterBefore.available - masterAfter.available;

  return {
    label,
    fundingXlm: Number(funding),
    userPublicKey: user.publicKey(),
    masterBefore,
    afterCreateMaster,
    afterCreateUser,
    masterAfter,
    userAfter,
    create,
    trustlines: [tl1, tl2],
    masterBalanceConsumed: Number(masterDelta.toFixed(7)),
    masterAvailableConsumed: Number(masterAvailableDelta.toFixed(7)),
    userBalance: userAfter.balance,
    userMinReserve: userAfter.minReserve,
    userAvailable: userAfter.available,
    masterNumSponsoringAfter: masterAfter.numSponsoring,
  };
}

async function main() {
  const server = new StellarSdk.Horizon.Server(HORIZON);
  const trustlineCount = 2; // USDC + EURC — matches buildReceiveTrustlineAssets()

  console.log('=== CODE FORMULA (estimateXlmRequiredForProvision) ===');
  for (const f of FUNDING_CANDIDATES) {
    console.log(
      JSON.stringify({
        userFunding: f,
        trustlineCount,
        sponsorReserves: trustlineCount * BASE_RESERVE,
        extraBaseReserveBuffer: BASE_RESERVE,
        feeBuffer: 0.05,
        codeGateTotal: estimateCodeGate(f, trustlineCount),
        breakdown: `${f} + ${trustlineCount}*0.5 + 0.5 + 0.05 = ${estimateCodeGate(f, trustlineCount)}`,
      })
    );
  }

  const master = StellarSdk.Keypair.random();
  console.log('\n=== TESTNET MASTER (fresh + friendbot) ===');
  console.log({ masterPublicKey: master.publicKey() });
  await friendbot(master.publicKey());
  // Friendbot typically credits 10_000 XLM on testnet.
  const masterStart = await loadNative(server, master.publicKey());
  console.log({ masterStart });

  const results = [];
  for (let i = 1; i <= 2; i++) {
    console.log(`\n=== PROVISION ACCOUNT #${i} with 1.5 XLM funding ===`);
    const r = await provisionOne(server, master, '1.5', `user_${i}_funding_1_5`);
    results.push(r);
    console.log(
      JSON.stringify(
        {
          label: r.label,
          userPublicKey: r.userPublicKey,
          createTx: r.create,
          trustlineTxs: r.trustlines,
          masterBefore: {
            balance: r.masterBefore.balance,
            available: r.masterBefore.available,
            numSponsoring: r.masterBefore.numSponsoring,
            minReserve: r.masterBefore.minReserve,
          },
          afterCreateOnly: {
            masterBalance: r.afterCreateMaster.balance,
            userBalance: r.afterCreateUser.balance,
            userMinReserve: r.afterCreateUser.minReserve,
            userAvailable: r.afterCreateUser.available,
          },
          final: {
            masterBalance: r.masterAfter.balance,
            masterAvailable: r.masterAfter.available,
            masterNumSponsoring: r.masterAfter.numSponsoring,
            masterMinReserve: r.masterAfter.minReserve,
            userBalance: r.userAfter.balance,
            userMinReserve: r.userAfter.minReserve,
            userAvailable: r.userAfter.available,
            userSubentries: r.userAfter.subentryCount,
            userNumSponsored: r.userAfter.numSponsored,
          },
          consumed: {
            masterBalanceDelta: r.masterBalanceConsumed,
            masterAvailableDelta: r.masterAvailableConsumed,
          },
        },
        null,
        2
      )
    );
  }

  // Also probe whether 1.5 is enough on the USER side for self-paid trustlines
  // (without sponsorship) — product question for non-sponsored path.
  console.log('\n=== SELF-PAID TRUSTLINE PROBE (no sponsorship, funding=1.5) ===');
  const probeUser = StellarSdk.Keypair.random();
  await createAccountFromMaster(server, master, probeUser.publicKey(), '1.5');
  await sleep(2000);
  const probeBefore = await loadNative(server, probeUser.publicKey());
  let selfPaidOk = false;
  let selfPaidError: string | null = null;
  try {
    const account = await server.loadAccount(probeUser.publicKey());
    const asset = new StellarSdk.Asset('USDC', TESTNET_USDC_ISSUER);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.changeTrust({ asset, limit: '10000000' })
      )
      .setTimeout(60)
      .build();
    tx.sign(probeUser);
    await server.submitTransaction(tx);
    selfPaidOk = true;
  } catch (e: unknown) {
    selfPaidError = e instanceof Error ? e.message : String(e);
  }
  const probeAfter = await loadNative(server, probeUser.publicKey());
  console.log(
    JSON.stringify(
      {
        funding: 1.5,
        before: {
          balance: probeBefore.balance,
          minReserve: probeBefore.minReserve,
          available: probeBefore.available,
        },
        selfPaidTrustlineOk: selfPaidOk,
        selfPaidError,
        after: {
          balance: probeAfter.balance,
          minReserve: probeAfter.minReserve,
          available: probeAfter.available,
          subentries: probeAfter.subentryCount,
        },
      },
      null,
      2
    )
  );

  const marginal = results.map((r) => ({
    label: r.label,
    masterBalanceConsumed: r.masterBalanceConsumed,
    masterAvailableConsumed: r.masterAvailableConsumed,
    userFunding: r.fundingXlm,
    userFinalBalance: r.userBalance,
    userMinReserve: r.userMinReserve,
    userAvailable: r.userAvailable,
  }));

  console.log('\n=== SUMMARY ===');
  console.log(
    JSON.stringify(
      {
        codeGateAt1_5: estimateCodeGate(1.5, 2),
        codeGateAt1_0: estimateCodeGate(1.0, 2),
        productionErrorExplained:
          '3.05 = 1.5 (createAccount to user) + 1.0 (2 sponsored trustline reserves on MASTER) + 0.5 (extra master buffer in code) + 0.05 (fee buffer)',
        measuredMarginal: marginal,
        averageMasterBalanceConsumed:
          marginal.reduce((s, m) => s + m.masterBalanceConsumed, 0) /
          marginal.length,
        averageMasterAvailableConsumed:
          marginal.reduce((s, m) => s + m.masterAvailableConsumed, 0) /
          marginal.length,
        recommendation:
          'USER funding stays 1.5 XLM. Master liquidity gate should track createAccount + sponsored reserves + small fee buffer — do not treat the whole gate as "per-user deposit".',
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
