/**
 * Increment H — Testnet proof: Alice USDC → Dayfi treasury → Provider (simulated).
 *
 * Stellar leg is real Testnet. Provider leg is labeled simulated in Testnet.
 *
 * Usage: npm run proof:infra-h-testnet
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
import { settleFiatOfframp } from '../src/modules/infra/infraFiatWithdrawalService';
import { getDayfiTreasuryPublicKey } from '../src/modules/infra/infraStellarFundingService';
import { runReconciliation } from '../src/modules/infra/infraReconciliationService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local'), override: true });

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock'; // Provider simulated; Stellar live
process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'live';
process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
delete process.env.USDC_ISSUER;
delete process.env.MASTER_WALLET_PUBLIC_KEY;

const SENDER_FILE = path.join(__dirname, '..', '.testnet-deposit-sender.local.json');
const FEE_PAYER_FILE = path.join(
  __dirname,
  '..',
  '.testnet-e-onchain-fee-payer.local.json'
);
const TREASURY_FILE = path.join(__dirname, '..', '.testnet-treasury.local.json');
const PROOF_AMOUNT = Number(process.env.INFRA_H_PROOF_AMOUNT || '30');
const LEDGER_SEED = Number(process.env.INFRA_H_LEDGER_SEED || '100');

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

async function stellarBalances(publicKey: string): Promise<{
  usdc: number;
  xlm: number;
}> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const issuer = resolveUsdcIssuer(true);
    const usdc = (
      account.balances as {
        asset_code?: string;
        asset_issuer?: string;
        asset_type?: string;
        balance?: string;
      }[]
    ).find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    const native = (
      account.balances as { asset_type?: string; balance?: string }[]
    ).find((b) => b.asset_type === 'native');
    return {
      usdc: parseFloat(String(usdc?.balance || '0')) || 0,
      xlm: parseFloat(String(native?.balance || '0')) || 0,
    };
  } catch {
    return { usdc: 0, xlm: 0 };
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

async function verifyHorizon(
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
        feeCharged: (tx as { fee_charged?: string }).fee_charged,
        feeAccount:
          (tx as { fee_account?: string }).fee_account ||
          (tx as { fee_bump_transaction?: { fee_source?: string } })
            .fee_bump_transaction?.fee_source ||
          null,
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
  throw new Error(`Horizon did not index ${hash}`);
}

function loadOrCreateKeypair(file: string, envSecretKey?: string, envPkKey?: string) {
  if (envSecretKey && process.env[envSecretKey]) {
    const secret = process.env[envSecretKey]!.trim();
    const kp = StellarSdk.Keypair.fromSecret(secret);
    if (envPkKey) process.env[envPkKey] = kp.publicKey();
    return { publicKey: kp.publicKey(), secret };
  }
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      publicKey: string;
      secret: string;
    };
    if (envSecretKey) process.env[envSecretKey] = stored.secret;
    if (envPkKey) process.env[envPkKey] = stored.publicKey;
    return stored;
  }
  const kp = StellarSdk.Keypair.random();
  const stored = { publicKey: kp.publicKey(), secret: kp.secret() };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
  if (envSecretKey) process.env[envSecretKey] = stored.secret;
  if (envPkKey) process.env[envPkKey] = stored.publicKey;
  return stored;
}

async function main() {
  const report: Report = {
    network: 'testnet',
    proofAmount: PROOF_AMOUNT,
    providerLeg: 'simulated',
    stellarLeg: 'live',
  };

  if (!fs.existsSync(SENDER_FILE)) {
    report.blocked = true;
    report.blockReason = 'Missing .testnet-deposit-sender.local.json';
    log('FINAL REPORT (BLOCKED)', report);
    process.exit(2);
  }
  const faucet = JSON.parse(fs.readFileSync(SENDER_FILE, 'utf8')) as {
    publicKey: string;
    secret: string;
  };

  const feePayer = loadOrCreateKeypair(
    FEE_PAYER_FILE,
    'DAYFI_STELLAR_FEE_PAYER_SECRET',
    'DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY'
  );
  await fundWithFriendbot(feePayer.publicKey);

  const treasury = loadOrCreateKeypair(
    TREASURY_FILE,
    'DAYFI_STELLAR_SETTLEMENT_SECRET'
  );
  await fundWithFriendbot(treasury.publicKey);
  // Ensure treasury USDC trustline
  {
    const cfg = getStellarConfig();
    const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
    const issuer = resolveUsdcIssuer(true);
    const asset = new StellarSdk.Asset('USDC', issuer);
    const account = await server.loadAccount(treasury.publicKey);
    const has = (
      account.balances as { asset_code?: string; asset_issuer?: string }[]
    ).some((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    if (!has) {
      const kp = StellarSdk.Keypair.fromSecret(treasury.secret);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: cfg.networkPassphrase,
      })
        .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: '1000000000' }))
        .setTimeout(60)
        .build();
      tx.sign(kp);
      await server.submitTransaction(tx);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  report.treasuryPublicKey = getDayfiTreasuryPublicKey() || treasury.publicKey;
  report.feePayerPublicKey = feePayer.publicKey;

  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [
      'Alice Testnet H Proof',
      `alice-h-proof-${crypto.randomBytes(4).toString('hex')}`,
    ]
  );
  await bootstrapOrgWallets(org.id);
  report.aliceOrgId = org.id;

  try {
    const aliceWallet = await provisionOrgStellarAccount({
      orgId: org.id,
      environment: 'test',
      mode: 'live',
    });
    report.alicePublicKey = aliceWallet.publicKey;
    await new Promise((r) => setTimeout(r, 2000));

    const fundHash = await fundAliceOnChain({
      fromSecret: faucet.secret,
      toPublicKey: aliceWallet.publicKey,
      amount: Math.max(PROOF_AMOUNT + 20, 50),
    });
    report.aliceFundHash = fundHash;
    await new Promise((r) => setTimeout(r, 2000));

    const aliceStellarBefore = await stellarBalances(aliceWallet.publicKey);
    const treasuryBefore = await stellarBalances(
      String(report.treasuryPublicKey)
    );
    report.aliceStellarBefore = aliceStellarBefore;
    report.treasuryStellarBefore = treasuryBefore;

    if (aliceStellarBefore.usdc + 1e-7 < PROOF_AMOUNT) {
      report.blocked = true;
      report.blockReason = `Alice Stellar USDC ${aliceStellarBefore.usdc} < ${PROOF_AMOUNT}`;
      log('FINAL REPORT (BLOCKED)', report);
      process.exit(2);
    }

    await creditOrgWallet({
      orgId: org.id,
      environment: 'test',
      amount: LEDGER_SEED,
      idempotencyKey: `h-proof-seed-${org.id}`,
    });
    const ledgerBefore = await getOrgBalance(org.id, 'test');
    report.ledgerBefore = {
      available: ledgerBefore.available,
      locked: ledgerBefore.locked,
    };

    const payout = await createPayout({
      orgId: org.id,
      env: 'test',
      amount: PROOF_AMOUNT,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice Bank',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `h-proof-${org.id}`,
    });
    const locked = await getOrgBalance(org.id, 'test');
    report.afterLock = {
      available: locked.available,
      locked: locked.locked,
      payoutId: payout.id,
    };

    const settled = await settleFiatOfframp({
      orgId: org.id,
      payoutTransactionId: payout.id,
    });
    report.settlement = settled;

    await new Promise((r) => setTimeout(r, 2000));
    const aliceStellarAfter = await stellarBalances(aliceWallet.publicKey);
    const treasuryAfter = await stellarBalances(String(report.treasuryPublicKey));
    const ledgerAfter = await getOrgBalance(org.id, 'test');
    report.aliceStellarAfter = aliceStellarAfter;
    report.treasuryStellarAfter = treasuryAfter;
    report.ledgerAfter = {
      available: ledgerAfter.available,
      locked: ledgerAfter.locked,
    };

    const hash = String(settled.stellar?.externalReference || '');
    const horizon = await verifyHorizon(hash, {
      source: aliceWallet.publicKey,
      destination: String(report.treasuryPublicKey),
      amount: PROOF_AMOUNT,
    });
    report.horizonVerification = horizon;

    const recon = await runReconciliation({
      orgId: org.id,
      environment: 'test',
      transactionIds: [payout.id],
      idempotencyKey: `recon-h-proof-${payout.id}`,
      triggerSource: 'manual',
    });
    report.reconciliation = {
      resultCode: recon.items[0]?.resultCode,
      status: recon.items[0]?.status,
      settlementStatus: recon.items[0]?.settlement?.status,
    };

    const replay = await settleFiatOfframp({
      orgId: org.id,
      payoutTransactionId: payout.id,
    });
    const idempotency = {
      sameHash: replay.stellar?.externalReference === hash,
      duplicate: replay.duplicate === true || replay.status === 'completed',
    };
    report.idempotency = idempotency;

    const ok =
      settled.status === 'completed' &&
      horizon.verified === true &&
      Math.abs(aliceStellarAfter.usdc - (aliceStellarBefore.usdc - PROOF_AMOUNT)) <
        1e-6 &&
      Math.abs(
        treasuryAfter.usdc - (treasuryBefore.usdc + PROOF_AMOUNT)
      ) < 1e-6 &&
      Math.abs(ledgerAfter.available - (LEDGER_SEED - PROOF_AMOUNT)) < 1e-6 &&
      recon.items[0]?.resultCode === 'RECONCILED' &&
      idempotency.sameHash === true;

    report.pass = ok;
    report.note =
      'Stellar Alice→treasury is live Testnet. Provider payout is simulated (no real bank rail in Testnet).';
    log('FINAL REPORT', report);
    process.exit(ok ? 0 : 1);
  } finally {
    await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [org.id]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
