/**
 * Increment C — Stellar Testnet end-to-end proof.
 *
 * Proves: provider confirm → ledger pending → treasury → Alice wallet →
 * Stellar confirm → pending → available, with Horizon + reconciliation.
 *
 * Usage:
 *   npm run proof:infra-c-testnet
 *   npm run proof:infra-c-testnet -- --wait-minutes 5
 *
 * Env (forced to testnet live modes by this script):
 *   DAYFI_STELLAR_SETTLEMENT_SECRET — Testnet treasury secret (optional;
 *     generated + stored in .testnet-treasury.local.json if missing)
 *   INFRA_C_PROOF_AMOUNT — default 100 (uses min(treasury balance) if lower)
 */

import StellarSdk from '@stellar/stellar-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { configDotenv } from 'dotenv';
import { db } from '../src/config/database';
import { getStellarConfig } from '../src/config/stellarConfig';
import { resolveUsdcIssuer } from '../src/config/stellarIssuers';
import {
  bootstrapOrgWallets,
  creditOrgWalletPending,
  getOrgBalance,
} from '../src/modules/infra/infraLedgerService';
import { settleCollectionCredit } from '../src/modules/infra/infraLifecycleService';
import { simulateSettlement } from '../src/modules/infra/infraMoneyService';
import { provisionOrgStellarAccount } from '../src/modules/infra/infraStellarAccountService';
import { runReconciliation } from '../src/modules/infra/infraReconciliationService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local') });

// Testnet-only live modes
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE = 'live';
process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
delete process.env.USDC_ISSUER; // use testnet issuer
delete process.env.MASTER_WALLET_PUBLIC_KEY; // do not confuse treasury with mainnet master

const TREASURY_FILE = path.join(__dirname, '..', '.testnet-treasury.local.json');
const PROOF_AMOUNT = Number(process.env.INFRA_C_PROOF_AMOUNT || '100');
const WAIT_MINUTES = (() => {
  const idx = process.argv.indexOf('--wait-minutes');
  if (idx >= 0 && process.argv[idx + 1]) return Number(process.argv[idx + 1]) || 0;
  return 0;
})();

type Report = Record<string, unknown>;

function log(section: string, data: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function loadOrCreateTreasury(): { publicKey: string; secret: string; created: boolean } {
  const fromEnv = process.env.DAYFI_STELLAR_SETTLEMENT_SECRET?.trim();
  if (fromEnv && /^S[A-Z0-9]{55}$/.test(fromEnv)) {
    const kp = StellarSdk.Keypair.fromSecret(fromEnv);
    return { publicKey: kp.publicKey(), secret: fromEnv, created: false };
  }
  if (fs.existsSync(TREASURY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TREASURY_FILE, 'utf8')) as {
      publicKey: string;
      secret: string;
    };
    if (saved.secret && /^S[A-Z0-9]{55}$/.test(saved.secret)) {
      process.env.DAYFI_STELLAR_SETTLEMENT_SECRET = saved.secret;
      return { publicKey: saved.publicKey, secret: saved.secret, created: false };
    }
  }
  const kp = StellarSdk.Keypair.random();
  const payload = { publicKey: kp.publicKey(), secret: kp.secret(), network: 'testnet' };
  fs.writeFileSync(TREASURY_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  process.env.DAYFI_STELLAR_SETTLEMENT_SECRET = kp.secret();
  return { publicKey: kp.publicKey(), secret: kp.secret(), created: true };
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const cfg = getStellarConfig();
  const res = await fetch(
    `${cfg.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`
  );
  if (!res.ok) {
    const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
    await server.loadAccount(publicKey);
    return;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

async function ensureUsdcTrustline(publicKey: string, secret: string): Promise<void> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const issuer = resolveUsdcIssuer(true);
  const asset = new StellarSdk.Asset('USDC', issuer);
  const account = await server.loadAccount(publicKey);
  const has = (account.balances as { asset_code?: string; asset_issuer?: string }[]).some(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer
  );
  if (has) return;
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: '1000000000' }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
  await new Promise((r) => setTimeout(r, 1000));
}

async function accountUsdcBalance(publicKey: string): Promise<number> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const issuer = resolveUsdcIssuer(true);
    const row = (
      account.balances as { asset_code?: string; asset_issuer?: string; balance?: string }[]
    ).find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    return parseFloat(String(row?.balance || '0')) || 0;
  } catch {
    return 0;
  }
}

async function accountXlmBalance(publicKey: string): Promise<number> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const native = account.balances.find(
      (b: { asset_type?: string }) => b.asset_type === 'native'
    );
    return parseFloat(String(native?.balance || '0')) || 0;
  } catch {
    return 0;
  }
}

async function verifyTxOnHorizon(
  hash: string,
  expected: { source: string; destination: string; amount: number }
): Promise<Record<string, unknown>> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const tx = await server.transactions().transaction(hash).call();
  if (!tx.successful) {
    throw new Error(`Horizon: transaction ${hash} not successful`);
  }
  const ops = await server.operations().forTransaction(hash).call();
  const payment = ops.records.find(
    (op: Record<string, unknown>) => op.type === 'payment'
  ) as Record<string, unknown> | undefined;
  if (!payment) throw new Error('Horizon: no payment operation found');

  const issuer = resolveUsdcIssuer(true);
  const ok =
    String(payment.from) === expected.source &&
    String(payment.to) === expected.destination &&
    String(payment.asset_code) === 'USDC' &&
    String(payment.asset_issuer) === issuer &&
    Math.abs(Number(payment.amount) - expected.amount) < 0.0000002;

  return {
    verified: ok,
    hash: tx.hash,
    ledger: tx.ledger,
    successful: tx.successful,
    source: payment.from,
    destination: payment.to,
    asset: `${payment.asset_code}:${payment.asset_issuer}`,
    amount: payment.amount,
    createdAt: tx.created_at,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
  };
}

async function createAliceOrg(): Promise<string> {
  const slug = `alice-c-proof-${crypto.randomBytes(4).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    ['Alice Testnet C Proof', slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function insertCollection(orgId: string, amount: number): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
     VALUES ($1, 'test', $2, 'USDC', 'pending', 'bank_transfer', 'payment', 0, $3, $4::jsonb)
     RETURNING id::text AS id`,
    [
      orgId,
      amount,
      `proof-c-${crypto.randomUUID()}`,
      JSON.stringify({
        type: 'collection',
        usdcAmount: amount,
        provider: 'provider',
        settlementSource: 'testnet-proof',
      }),
    ]
  );
  return row.id;
}

async function pollTreasuryUsdc(
  publicKey: string,
  minAmount: number,
  waitMinutes: number
): Promise<number> {
  const deadline = Date.now() + waitMinutes * 60_000;
  let balance = await accountUsdcBalance(publicKey);
  while (balance + 1e-7 < minAmount && Date.now() < deadline) {
    console.log(
      `Waiting for Testnet USDC on treasury (${balance} / ${minAmount} needed)...`
    );
    await new Promise((r) => setTimeout(r, 15_000));
    balance = await accountUsdcBalance(publicKey);
  }
  return balance;
}

async function main() {
  const report: Report = {
    network: 'testnet',
    proofAmountTarget: PROOF_AMOUNT,
    successPath: null as unknown,
    failurePath: null as unknown,
    idempotency: null as unknown,
    testSuite: null as unknown,
    blocked: false,
    blockReason: null as string | null,
  };

  const treasury = loadOrCreateTreasury();
  report.treasuryPublicKey = treasury.publicKey;
  report.treasurySecretSource = treasury.created
    ? 'generated (.testnet-treasury.local.json)'
    : process.env.DAYFI_STELLAR_SETTLEMENT_SECRET
      ? 'DAYFI_STELLAR_SETTLEMENT_SECRET'
      : 'saved file';

  log('Treasury bootstrap', {
    publicKey: treasury.publicKey,
    created: treasury.created,
    file: treasury.created ? TREASURY_FILE : undefined,
  });

  await fundWithFriendbot(treasury.publicKey);
  await ensureUsdcTrustline(treasury.publicKey, treasury.secret);

  const xlm = await accountXlmBalance(treasury.publicKey);
  let treasuryUsdcBefore = await accountUsdcBalance(treasury.publicKey);
  report.treasuryXlmBefore = xlm;
  report.treasuryUsdcBefore = treasuryUsdcBefore;

  if (treasuryUsdcBefore + 1e-7 < PROOF_AMOUNT) {
    log(
      'Treasury USDC insufficient',
      {
        have: treasuryUsdcBefore,
        need: PROOF_AMOUNT,
        faucet: 'https://faucet.circle.com — select Stellar Testnet, paste treasury public key',
        note: 'Circle sends 20 USDC per request (max once per 2h). Re-run with --wait-minutes N to poll.',
      }
    );
    if (WAIT_MINUTES > 0) {
      treasuryUsdcBefore = await pollTreasuryUsdc(
        treasury.publicKey,
        PROOF_AMOUNT,
        WAIT_MINUTES
      );
      report.treasuryUsdcBefore = treasuryUsdcBefore;
    }
  }

  const proofAmount =
    treasuryUsdcBefore >= PROOF_AMOUNT
      ? PROOF_AMOUNT
      : treasuryUsdcBefore >= 20
        ? 20
        : treasuryUsdcBefore >= 10
          ? 10
          : 0;

  report.proofAmountUsed = proofAmount;

  // --- Alice org + wallet ---
  const orgId = await createAliceOrg();
  report.aliceOrgId = orgId;

  const aliceWallet = await provisionOrgStellarAccount({
    orgId,
    environment: 'test',
    mode: 'live',
  });
  report.alicePublicKey = aliceWallet.publicKey;
  report.aliceWalletStatus = aliceWallet.status;
  report.aliceNetwork = aliceWallet.network;

  const aliceUsdcBefore = await accountUsdcBalance(aliceWallet.publicKey);
  report.aliceUsdcBefore = aliceUsdcBefore;

  const ledgerBefore = await getOrgBalance(orgId, 'test');
  report.ledgerAvailableBefore = ledgerBefore.available;
  report.ledgerPendingBefore = ledgerBefore.pending;

  // --- Failure path (always runnable) ---
  const failOrgId = await createAliceOrg();
  await provisionOrgStellarAccount({ orgId: failOrgId, environment: 'test', mode: 'live' });
  const failPaymentId = await insertCollection(failOrgId, 999_999_999);
  const failBefore = await getOrgBalance(failOrgId, 'test');
  const failSettled = await settleCollectionCredit({
    orgId: failOrgId,
    transactionId: failPaymentId,
    providerEventId: `proof-fail-${failPaymentId}`,
    source: 'testnet-proof',
  });
  const failAfter = await getOrgBalance(failOrgId, 'test');
  report.failurePath = {
    status: failSettled.walletFunding?.status,
    ledgerPhase: failSettled.ledgerPhase,
    stellarHash: failSettled.walletFunding?.stellarTransactionHash ?? null,
    availableBefore: failBefore.available,
    pendingBefore: failBefore.pending,
    availableAfter: failAfter.available,
    pendingAfter: failAfter.pending,
    availableUnchanged: failAfter.available === failBefore.available,
    pendingIncreased: failAfter.pending > failBefore.pending,
    noFakeHash: !failSettled.walletFunding?.stellarTransactionHash,
    pass:
      failSettled.walletFunding?.status === 'pending_treasury' &&
      failSettled.ledgerPhase === 'pending' &&
      failAfter.available === failBefore.available &&
      !failSettled.walletFunding?.stellarTransactionHash,
  };

  if (proofAmount <= 0) {
    report.blocked = true;
    report.blockReason =
      'Treasury has no Testnet USDC. Fund via Circle faucet (Stellar Testnet) then re-run.';
    log('FINAL REPORT (BLOCKED — success path not run)', report);
    await db.none(`DELETE FROM infra_organizations WHERE id IN ($1, $2)`, [
      orgId,
      failOrgId,
    ]);
    process.exit(2);
  }

  // --- Mid-state observation (split existing services, separate org) ---
  const midOrgId = await createAliceOrg();
  await provisionOrgStellarAccount({ orgId: midOrgId, environment: 'test', mode: 'live' });
  const midPaymentId = await insertCollection(midOrgId, proofAmount);
  const midBefore = await getOrgBalance(midOrgId, 'test');
  await creditOrgWalletPending({
    orgId: midOrgId,
    environment: 'test',
    amount: proofAmount,
    idempotencyKey: `collection:${midPaymentId}:pending`,
    movementType: 'collection_pending',
    referenceType: 'collection',
    referenceId: midPaymentId,
    reference: midPaymentId,
    metadata: { source: 'testnet-proof-mid', ledgerPhase: 'pending' },
  });
  const midAfterPending = await getOrgBalance(midOrgId, 'test');
  report.midStateObservation = {
    paymentId: midPaymentId,
    availableBefore: midBefore.available,
    pendingBefore: midBefore.pending,
    availableAfterPendingCredit: midAfterPending.available,
    pendingAfterPendingCredit: midAfterPending.pending,
    availableUnchanged: midAfterPending.available === midBefore.available,
    pendingIncreasedBy: midAfterPending.pending - midBefore.pending,
    pass:
      midAfterPending.available === midBefore.available &&
      Math.abs(midAfterPending.pending - midBefore.pending - proofAmount) < 0.01,
  };

  // --- Main path via simulateSettlement (existing flow) ---
  const paymentId = await insertCollection(orgId, proofAmount);
  const sim = (await simulateSettlement({
    orgId,
    env: 'test',
    transactionId: paymentId,
  })) as {
    usdcAmount: number;
    balance: { available: number; pending: number };
    ledgerPhase?: string;
    walletFunding?: {
      status: string;
      stellarTransactionHash?: string | null;
      destinationPublicKey?: string;
    };
  };

  report.collectionTransactionId = paymentId;
  report.stellarTransactionHash = sim.walletFunding?.stellarTransactionHash;
  report.ledgerPhase = sim.ledgerPhase;
  report.walletFundingStatus = sim.walletFunding?.status;

  const treasuryUsdcAfter = await accountUsdcBalance(treasury.publicKey);
  const aliceUsdcAfter = await accountUsdcBalance(aliceWallet.publicKey);
  report.treasuryUsdcAfter = treasuryUsdcAfter;
  report.aliceUsdcAfter = aliceUsdcAfter;
  report.ledgerAvailableAfter = sim.balance.available;
  report.ledgerPendingAfter = sim.balance.pending;

  if (sim.walletFunding?.stellarTransactionHash) {
    report.horizonVerification = await verifyTxOnHorizon(
      sim.walletFunding.stellarTransactionHash,
      {
        source: treasury.publicKey,
        destination: aliceWallet.publicKey,
        amount: proofAmount,
      }
    );
  }

  const recon = await runReconciliation({
    orgId,
    environment: 'test',
    transactionIds: [paymentId],
    idempotencyKey: `recon-proof-c-${paymentId}`,
    triggerSource: 'test',
  });
  report.reconciliation = {
    status: recon.items[0]?.status,
    resultCode: recon.items[0]?.resultCode,
    settlementPresent: recon.items[0]?.settlement?.present,
    settlementStatus: recon.items[0]?.settlement?.status,
    ledgerPresent: recon.items[0]?.ledger?.present,
  };

  // --- Idempotency replay ---
  const replayBefore = await getOrgBalance(orgId, 'test');
  const replay = await settleCollectionCredit({
    orgId,
    transactionId: paymentId,
    providerEventId: `proof-replay-${paymentId}`,
    source: 'testnet-proof',
  });
  const replayAfter = await getOrgBalance(orgId, 'test');
  const settlementCount = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM infra_settlements
     WHERE collection_transaction_id = $1 AND status = 'confirmed'`,
    [paymentId]
  );
  const availMoves = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM infra_ledger_movements
     WHERE reference_id = $1 AND movement_type = 'collection_credit'`,
    [paymentId]
  );
  report.idempotency = {
    duplicate: replay.credit.duplicate,
    sameHash: replay.walletFunding?.stellarTransactionHash === sim.walletFunding?.stellarTransactionHash,
    availableUnchanged: replayAfter.available === replayBefore.available,
    confirmedSettlements: Number(settlementCount.n),
    availableMovements: Number(availMoves.n),
    pass:
      replay.credit.duplicate === true &&
      replayAfter.available === replayBefore.available &&
      Number(settlementCount.n) === 1 &&
      Number(availMoves.n) === 1,
  };

  report.successPath = {
    pass:
      sim.ledgerPhase === 'available' &&
      sim.walletFunding?.status === 'confirmed' &&
      Boolean(sim.walletFunding?.stellarTransactionHash) &&
      (report.horizonVerification as { verified?: boolean })?.verified === true &&
      Math.abs(aliceUsdcAfter - aliceUsdcBefore - proofAmount) < 0.01 &&
      recon.items[0]?.status === 'reconciled',
  };

  log('FINAL REPORT', report);

  await db.none(`DELETE FROM infra_organizations WHERE id IN ($1, $2, $3)`, [
    orgId,
    failOrgId,
    midOrgId,
  ]);

  const ok =
    (report.successPath as { pass?: boolean })?.pass === true &&
    (report.failurePath as { pass?: boolean })?.pass === true &&
    (report.idempotency as { pass?: boolean })?.pass === true;

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Proof failed:', err);
  process.exit(1);
});
