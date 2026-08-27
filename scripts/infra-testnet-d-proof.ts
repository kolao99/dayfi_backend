/**
 * Increment D — Stellar Testnet external deposit proof.
 *
 * External Testnet wallet → $50 USDC → Alice Dayfi wallet → verify → ledger.
 *
 * Usage:
 *   npm run proof:infra-d-testnet
 *
 * Requires:
 *   - Local/remote DB with migrations
 *   - Alice org provisioned live on Testnet
 *   - External sender funded with Testnet USDC (or Sozu faucet)
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
  getOrgBalance,
} from '../src/modules/infra/infraLedgerService';
import { provisionOrgStellarAccount } from '../src/modules/infra/infraStellarAccountService';
import {
  pollOrgStellarDeposits,
  processExternalDepositByHash,
  verifyExternalUsdcDeposit,
} from '../src/modules/infra/infraStellarDepositService';
import { runReconciliation } from '../src/modules/infra/infraReconciliationService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local') });

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = 'live';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
delete process.env.USDC_ISSUER;
delete process.env.MASTER_WALLET_PUBLIC_KEY;

const SENDER_FILE = path.join(__dirname, '..', '.testnet-deposit-sender.local.json');
const PROOF_AMOUNT = Number(process.env.INFRA_D_PROOF_AMOUNT || '50');

type Report = Record<string, unknown>;

function log(section: string, data: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function loadOrCreateSender(): { publicKey: string; secret: string } {
  if (fs.existsSync(SENDER_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SENDER_FILE, 'utf8')) as {
      publicKey: string;
      secret: string;
    };
    if (saved.secret && /^S[A-Z0-9]{55}$/.test(saved.secret)) return saved;
  }
  const kp = StellarSdk.Keypair.random();
  const payload = { publicKey: kp.publicKey(), secret: kp.secret(), network: 'testnet' };
  fs.writeFileSync(SENDER_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
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

async function sendUsdc(input: {
  secret: string;
  destination: string;
  amount: number;
}): Promise<string> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const kp = StellarSdk.Keypair.fromSecret(input.secret);
  const issuer = resolveUsdcIssuer(true);
  const asset = new StellarSdk.Asset('USDC', issuer);
  const account = await server.loadAccount(kp.publicKey());
  const amount = (Math.round(input.amount * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: input.destination,
        asset,
        amount,
      })
    )
    .addMemo(StellarSdk.Memo.text('dayfi-d-proof'))
    .setTimeout(180)
    .build();
  tx.sign(kp);
  const result = await server.submitTransaction(tx);
  return String(result.hash);
}

async function createAliceOrg(): Promise<string> {
  const slug = `alice-d-proof-${crypto.randomBytes(4).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    ['Alice Testnet D Proof', slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function main() {
  const report: Report = {
    network: 'testnet',
    proofAmount: PROOF_AMOUNT,
    successPath: null,
    duplicatePoll: null,
    invalidTests: null,
    blocked: false,
  };

  const sender = loadOrCreateSender();
  report.externalSenderPublicKey = sender.publicKey;
  log('External sender', { publicKey: sender.publicKey });

  await fundWithFriendbot(sender.publicKey);
  await ensureUsdcTrustline(sender.publicKey, sender.secret);

  let senderUsdc = await accountUsdcBalance(sender.publicKey);
  report.senderUsdcBefore = senderUsdc;

  if (senderUsdc + 1e-7 < PROOF_AMOUNT) {
    report.blocked = true;
    report.blockReason =
      `Sender has ${senderUsdc} USDC; need ${PROOF_AMOUNT}. Fund via Circle faucet or: npx @sozu/faucet claim ${sender.publicKey}`;
    log('FINAL REPORT (BLOCKED)', report);
    process.exit(2);
  }

  const orgId = await createAliceOrg();
  const alice = await provisionOrgStellarAccount({
    orgId,
    environment: 'test',
    mode: 'live',
  });
  report.alicePublicKey = alice.publicKey;
  report.aliceStatus = alice.status;

  const aliceUsdcBefore = await accountUsdcBalance(alice.publicKey);
  const ledgerBefore = await getOrgBalance(orgId, 'test');
  report.aliceUsdcBefore = aliceUsdcBefore;
  report.ledgerAvailableBefore = ledgerBefore.available;
  report.ledgerPendingBefore = ledgerBefore.pending;

  // --- Invalid path checks (no credit) ---
  const invalid: Record<string, boolean> = {};
  try {
    await verifyExternalUsdcDeposit({ stellarTxHash: 'not-a-hash' });
    invalid.malformedHash = false;
  } catch (e: unknown) {
    invalid.malformedHash =
      e instanceof Error && (e as { code?: string }).code === 'INVALID_HASH';
  }
  try {
    await verifyExternalUsdcDeposit({ stellarTxHash: 'b'.repeat(64) });
    invalid.nonexistentHash = false;
  } catch (e: unknown) {
    invalid.nonexistentHash =
      e instanceof Error && (e as { code?: string }).code === 'TX_NOT_FOUND';
  }
  report.invalidTests = invalid;

  // --- Real send ---
  const hash = await sendUsdc({
    secret: sender.secret,
    destination: alice.publicKey,
    amount: PROOF_AMOUNT,
  });
  report.stellarTransactionHash = hash;
  report.assetIssuer = resolveUsdcIssuer(true);
  report.amountSent = PROOF_AMOUNT;
  log('Sent on-chain', {
    hash,
    explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
  });

  await new Promise((r) => setTimeout(r, 2000));

  const verified = await verifyExternalUsdcDeposit({
    stellarTxHash: hash,
    expectedDestination: alice.publicKey,
    expectedAmount: PROOF_AMOUNT,
  });
  report.verification = {
    successful: verified.successful,
    source: verified.sourcePublicKey,
    destination: verified.destinationPublicKey,
    amount: verified.amount,
    assetIssuer: verified.assetIssuer,
  };

  // Mid-state: pending only
  const mid = await processExternalDepositByHash({
    stellarTxHash: hash,
    expectedDestination: alice.publicKey,
    expectedAmount: PROOF_AMOUNT,
    stopAfterPending: true,
  });
  report.ledgerPendingAfterDetect = mid.balance.pending;
  report.ledgerAvailableAfterDetect = mid.balance.available;
  report.midPendingOnly =
    mid.ledgerPhase === 'pending' &&
    mid.balance.available === ledgerBefore.available &&
    Math.abs(mid.balance.pending - ledgerBefore.pending - PROOF_AMOUNT) < 0.01;

  // Confirm → available
  const credited = await processExternalDepositByHash({
    stellarTxHash: hash,
    expectedDestination: alice.publicKey,
    expectedAmount: PROOF_AMOUNT,
  });
  report.depositRecord = {
    id: credited.deposit.id,
    status: credited.deposit.status,
    transactionId: credited.deposit.transactionId,
    amount: credited.deposit.amount,
  };
  report.ledgerAvailableAfter = credited.balance.available;
  report.ledgerPendingAfter = credited.balance.pending;

  const aliceUsdcAfter = await accountUsdcBalance(alice.publicKey);
  const senderUsdcAfter = await accountUsdcBalance(sender.publicKey);
  report.aliceUsdcAfter = aliceUsdcAfter;
  report.senderUsdcAfter = senderUsdcAfter;

  const recon = await runReconciliation({
    orgId,
    environment: 'test',
    transactionIds: [credited.deposit.transactionId!],
    idempotencyKey: `recon-d-proof-${hash}`,
    triggerSource: 'test',
  });
  report.reconciliation = {
    status: recon.items[0]?.status,
    resultCode: recon.items[0]?.resultCode,
    direction: recon.items[0]?.direction,
    providerPresent: recon.items[0]?.provider?.present,
    settlementRef: recon.items[0]?.settlement?.externalReference,
  };

  // Duplicate poll / process
  const poll1 = await pollOrgStellarDeposits({ orgId, environment: 'test' });
  const poll2 = await pollOrgStellarDeposits({ orgId, environment: 'test' });
  const again = await processExternalDepositByHash({
    stellarTxHash: hash,
    expectedDestination: alice.publicKey,
  });
  const depositCount = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM infra_stellar_deposits WHERE stellar_tx_hash = $1`,
    [hash]
  );
  const creditCount = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM infra_ledger_movements
     WHERE reference = $1 AND movement_type = 'deposit_credit'`,
    [hash]
  );
  report.duplicatePoll = {
    poll1Processed: poll1.processed,
    poll2Processed: poll2.processed,
    replayDuplicate: again.duplicate,
    depositRows: Number(depositCount.n),
    availableMovements: Number(creditCount.n),
    pass:
      again.duplicate === true &&
      Number(depositCount.n) === 1 &&
      Number(creditCount.n) === 1,
  };

  // Wrong destination (verify against Alice but claim Bob)
  let wrongDestRejected = false;
  try {
    await verifyExternalUsdcDeposit({
      stellarTxHash: hash,
      expectedDestination: `G${'Z'.repeat(55)}`,
    });
  } catch (e: unknown) {
    wrongDestRejected =
      e instanceof Error && (e as { code?: string }).code === 'WRONG_DESTINATION';
  }
  report.wrongDestinationRejected = wrongDestRejected;

  report.successPath = {
    pass:
      verified.successful &&
      credited.ledgerPhase === 'available' &&
      credited.deposit.status === 'confirmed' &&
      Math.abs(aliceUsdcAfter - aliceUsdcBefore - PROOF_AMOUNT) < 0.01 &&
      Math.abs(credited.balance.available - ledgerBefore.available - PROOF_AMOUNT) < 0.01 &&
      recon.items[0]?.status === 'reconciled' &&
      (report.duplicatePoll as { pass?: boolean }).pass === true &&
      wrongDestRejected &&
      invalid.malformedHash &&
      invalid.nonexistentHash,
  };

  log('FINAL REPORT', report);

  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);

  const ok = (report.successPath as { pass?: boolean })?.pass === true;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Proof failed:', err);
  process.exit(1);
});
