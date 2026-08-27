/**
 * Increment F — Testnet proof: Alice org wallet → external USDC.
 *
 * Usage: npm run proof:infra-f-testnet
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
  creditOrgWallet,
  getOrgBalance,
} from '../src/modules/infra/infraLedgerService';
import { createPayout } from '../src/modules/infra/infraMoneyService';
import { provisionOrgStellarAccount } from '../src/modules/infra/infraStellarAccountService';
import {
  settlePayoutOnStellar,
} from '../src/modules/infra/infraSettlementService';
import { runReconciliation } from '../src/modules/infra/infraReconciliationService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local'), override: true });

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = 'live';
process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
delete process.env.USDC_ISSUER;
delete process.env.MASTER_WALLET_PUBLIC_KEY;

const SENDER_FILE = path.join(__dirname, '..', '.testnet-deposit-sender.local.json');
const PROOF_AMOUNT = Number(process.env.INFRA_F_PROOF_AMOUNT || '25');
const LEDGER_SEED = Number(process.env.INFRA_F_LEDGER_SEED || '100');

type Report = Record<string, unknown>;

function log(section: string, data: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
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

async function fundAliceOnChain(input: {
  fromSecret: string;
  toPublicKey: string;
  amount: number;
}): Promise<string> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const kp = StellarSdk.Keypair.fromSecret(input.fromSecret);
  const asset = new StellarSdk.Asset('USDC', resolveUsdcIssuer(true));
  const account = await server.loadAccount(kp.publicKey());
  const amt = (Math.round(input.amount * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: input.toPublicKey,
        asset,
        amount: amt,
      })
    )
    .setTimeout(180)
    .build();
  tx.sign(kp);
  const result = await server.submitTransaction(tx);
  return String(result.hash);
}

async function verifyTxOnHorizon(
  hash: string,
  expected: { source: string; destination: string; amount: number }
) {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const issuer = resolveUsdcIssuer(true);
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const tx = await server.transactions().transaction(hash).call();
      const ops = await server.operations().forTransaction(hash).call();
      const payment = ops.records.find(
        (op: Record<string, unknown>) => op.type === 'payment'
      ) as Record<string, unknown> | undefined;
      return {
        verified:
          tx.successful === true &&
          String(payment?.from) === expected.source &&
          String(payment?.to) === expected.destination &&
          String(payment?.asset_code) === 'USDC' &&
          String(payment?.asset_issuer) === issuer &&
          Math.abs(Number(payment?.amount) - expected.amount) < 0.0000002,
        hash: tx.hash,
        source: payment?.from,
        destination: payment?.to,
        amount: payment?.amount,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
      };
    } catch (err: unknown) {
      const status =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined;
      if (status !== 404 || attempt === 23) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Horizon did not index transaction ${hash}`);
}

async function createAliceOrg(): Promise<string> {
  const slug = `alice-f-proof-${crypto.randomBytes(4).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    ['Alice Testnet F Proof', slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function main() {
  const report: Report = { network: 'testnet', proofAmount: PROOF_AMOUNT };

  if (!fs.existsSync(SENDER_FILE)) {
    report.blocked = true;
    report.blockReason = 'Missing .testnet-deposit-sender.local.json — run D proof or fund sender first';
    log('FINAL REPORT (BLOCKED)', report);
    process.exit(2);
  }
  const sender = JSON.parse(fs.readFileSync(SENDER_FILE, 'utf8')) as {
    publicKey: string;
    secret: string;
  };
  const senderUsdc = await accountUsdcBalance(sender.publicKey);
  if (senderUsdc + 1e-7 < Math.max(PROOF_AMOUNT * 2, 50)) {
    report.blocked = true;
    report.blockReason = `Sender has ${senderUsdc} USDC; need ${Math.max(PROOF_AMOUNT * 2, 50)}. Fund via: npx @sozu/faucet claim ${sender.publicKey}`;
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

  const external = StellarSdk.Keypair.random();
  report.externalDestination = external.publicKey();
  await fundWithFriendbot(external.publicKey());
  await ensureUsdcTrustline(external.publicKey(), external.secret());

  // Fund Alice on-chain so org wallet can sign live send
  const fundHash = await fundAliceOnChain({
    fromSecret: sender.secret,
    toPublicKey: alice.publicKey,
    amount: Math.max(PROOF_AMOUNT * 2, 50),
  });
  report.aliceFundingTx = fundHash;
  await new Promise((r) => setTimeout(r, 3000));

  const aliceUsdcBefore = await accountUsdcBalance(alice.publicKey);
  const externalUsdcBefore = await accountUsdcBalance(external.publicKey());
  report.aliceUsdcBefore = aliceUsdcBefore;
  report.externalUsdcBefore = externalUsdcBefore;

  if (aliceUsdcBefore + 1e-7 < PROOF_AMOUNT) {
    report.blocked = true;
    report.blockReason = `Alice on-chain USDC (${aliceUsdcBefore}) insufficient for ${PROOF_AMOUNT}`;
    log('FINAL REPORT (BLOCKED)', report);
    await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
    process.exit(2);
  }

  await creditOrgWallet({
    orgId,
    environment: 'test',
    amount: LEDGER_SEED,
    idempotencyKey: `f-proof-seed-${orgId}`,
  });
  const ledgerBefore = await getOrgBalance(orgId, 'test');
  report.ledgerAvailableBefore = ledgerBefore.available;
  report.ledgerLockedBefore = ledgerBefore.locked;

  const payout = await createPayout({
    orgId,
    env: 'test',
    amount: PROOF_AMOUNT,
    currency: 'USDC',
    accountType: 'crypto',
    asset: 'USDC',
    network: 'stellar',
    walletAddress: external.publicKey(),
  });
  report.payoutId = payout.id;

  const locked = await getOrgBalance(orgId, 'test');
  report.ledgerAvailableAfterLock = locked.available;
  report.ledgerLockedAfterLock = locked.locked;
  report.lockCorrect =
    Math.abs(locked.available - (ledgerBefore.available - PROOF_AMOUNT)) < 0.01 &&
    Math.abs(locked.locked - (ledgerBefore.locked + PROOF_AMOUNT)) < 0.01;

  const settled = await settlePayoutOnStellar({
    orgId,
    payoutTransactionId: payout.id,
  });
  report.stellarTransactionHash = settled.settlement.externalReference;
  report.settlementSource = settled.settlement.sourceRef;
  report.signingSource = settled.settlement.railMetadata.signingSource;

  report.horizonVerification = await verifyTxOnHorizon(
    settled.settlement.externalReference!,
    {
      source: alice.publicKey,
      destination: external.publicKey(),
      amount: PROOF_AMOUNT,
    }
  );

  const ledgerAfter = await getOrgBalance(orgId, 'test');
  report.ledgerAvailableAfter = ledgerAfter.available;
  report.ledgerLockedAfter = ledgerAfter.locked;

  const aliceUsdcAfter = await accountUsdcBalance(alice.publicKey);
  const externalUsdcAfter = await accountUsdcBalance(external.publicKey());
  report.aliceUsdcAfter = aliceUsdcAfter;
  report.externalUsdcAfter = externalUsdcAfter;

  const recon = await runReconciliation({
    orgId,
    environment: 'test',
    transactionIds: [payout.id],
    idempotencyKey: `recon-f-proof-${payout.id}`,
    triggerSource: 'test',
  });
  report.reconciliation = {
    status: recon.items[0]?.status,
    resultCode: recon.items[0]?.resultCode,
    settlementRef: recon.items[0]?.settlement?.externalReference,
  };

  const replay = await settlePayoutOnStellar({
    orgId,
    payoutTransactionId: payout.id,
  });
  const ledgerReplay = await getOrgBalance(orgId, 'test');
  report.idempotency = {
    sameSettlement: replay.settlement.id === settled.settlement.id,
    sameHash: replay.settlement.externalReference === settled.settlement.externalReference,
    balanceUnchanged: ledgerReplay.available === ledgerAfter.available,
  };

  report.successPath = {
    pass:
      settled.settlement.status === 'confirmed' &&
      settled.settlement.sourceRef === alice.publicKey &&
      report.signingSource === 'org_wallet' &&
      (report.horizonVerification as { verified?: boolean }).verified === true &&
      Math.abs(externalUsdcAfter - externalUsdcBefore - PROOF_AMOUNT) < 0.01 &&
      Math.abs(ledgerAfter.available - ledgerBefore.available + PROOF_AMOUNT) < 0.01 &&
      ledgerAfter.locked === ledgerBefore.locked &&
      recon.items[0]?.status === 'reconciled' &&
      (report.idempotency as { sameHash?: boolean }).sameHash === true,
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
