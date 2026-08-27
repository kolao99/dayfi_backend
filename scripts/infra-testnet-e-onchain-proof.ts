/**
 * Increment E-ONCHAIN — Testnet proof: Alice → Bob real Stellar USDC.
 *
 * Inner: Alice authorizes USDC payment.
 * Fee-bump: Dayfi XLM fee-payer pays network fee.
 * Dayfi fee $0.01 is ledger-only (not a second USDC payment).
 *
 * Usage: npm run proof:infra-e-onchain-testnet
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
import { provisionOrgStellarAccount } from '../src/modules/infra/infraStellarAccountService';
import { createInternalTransfer } from '../src/modules/infra/infraInternalTransferService';
import { ensureFeeRevenueOrg } from '../src/modules/infra/infraFeeService';
import { runReconciliation } from '../src/modules/infra/infraReconciliationService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local'), override: true });

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'live';
process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
process.env.DAYFI_TRANSACTION_FEE_USDC = process.env.DAYFI_TRANSACTION_FEE_USDC || '0.01';
process.env.DAYFI_INFRA_INTERNAL_TRANSFER_FEE = 'off';
delete process.env.USDC_ISSUER;
delete process.env.MASTER_WALLET_PUBLIC_KEY;

const SENDER_FILE = path.join(__dirname, '..', '.testnet-deposit-sender.local.json');
const FEE_PAYER_FILE = path.join(
  __dirname,
  '..',
  '.testnet-e-onchain-fee-payer.local.json'
);
const PROOF_AMOUNT = Number(process.env.INFRA_E_ONCHAIN_PROOF_AMOUNT || '30');
const ALICE_LEDGER_SEED = Number(process.env.INFRA_E_ONCHAIN_ALICE_SEED || '100');
const BOB_LEDGER_SEED = Number(process.env.INFRA_E_ONCHAIN_BOB_SEED || '20');
const FEE_USDC = Number(process.env.DAYFI_TRANSACTION_FEE_USDC || '0.01');

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
  exists: boolean;
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
      exists: true,
    };
  } catch {
    return { usdc: 0, xlm: 0, exists: false };
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

async function verifyFeeBumpOnHorizon(
  hash: string,
  expected: {
    source: string;
    destination: string;
    amount: number;
    feePayer: string;
  }
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
      const feeAccount =
        (tx as { fee_account?: string }).fee_account ||
        (tx as { fee_bump_transaction?: { fee_source?: string } })
          .fee_bump_transaction?.fee_source ||
        null;
      const feeCharged =
        (tx as { fee_charged?: string | number }).fee_charged != null
          ? String((tx as { fee_charged?: string | number }).fee_charged)
          : null;
      return {
        verified:
          tx.successful === true &&
          String(payment?.from) === expected.source &&
          String(payment?.to) === expected.destination &&
          String(payment?.asset_code) === 'USDC' &&
          String(payment?.asset_issuer) === issuer &&
          Math.abs(Number(payment?.amount) - expected.amount) < 0.0000002 &&
          feeAccount === expected.feePayer,
        hash: tx.hash,
        source: payment?.from,
        destination: payment?.to,
        amount: payment?.amount,
        feeAccount,
        feeChargedStroops: feeCharged,
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

function loadOrCreateFeePayer(): { publicKey: string; secret: string } {
  if (process.env.DAYFI_STELLAR_FEE_PAYER_SECRET) {
    const secret = process.env.DAYFI_STELLAR_FEE_PAYER_SECRET.trim();
    const kp = StellarSdk.Keypair.fromSecret(secret);
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = kp.publicKey();
    return { publicKey: kp.publicKey(), secret };
  }
  if (fs.existsSync(FEE_PAYER_FILE)) {
    const stored = JSON.parse(fs.readFileSync(FEE_PAYER_FILE, 'utf8')) as {
      publicKey: string;
      secret: string;
    };
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = stored.secret;
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = stored.publicKey;
    return stored;
  }
  const kp = StellarSdk.Keypair.random();
  const stored = { publicKey: kp.publicKey(), secret: kp.secret() };
  fs.writeFileSync(FEE_PAYER_FILE, JSON.stringify(stored, null, 2));
  process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = stored.secret;
  process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = stored.publicKey;
  return stored;
}

async function createOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase()}-eon-proof-${crypto.randomBytes(4).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`${name} Testnet E-ONCHAIN Proof`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function main() {
  const report: Report = {
    network: 'testnet',
    proofAmount: PROOF_AMOUNT,
    dayfiFeeUsdc: FEE_USDC,
  };

  if (!fs.existsSync(SENDER_FILE)) {
    report.blocked = true;
    report.blockReason =
      'Missing .testnet-deposit-sender.local.json — fund Alice via D/F sender first';
    log('FINAL REPORT (BLOCKED)', report);
    process.exit(2);
  }
  const usdcFaucet = JSON.parse(fs.readFileSync(SENDER_FILE, 'utf8')) as {
    publicKey: string;
    secret: string;
  };
  const faucetUsdc = (await stellarBalances(usdcFaucet.publicKey)).usdc;
  if (faucetUsdc + 1e-7 < Math.max(PROOF_AMOUNT + 5, 50)) {
    report.blocked = true;
    report.blockReason = `Sender has ${faucetUsdc} USDC; need >= ${Math.max(
      PROOF_AMOUNT + 5,
      50
    )}. Fund via: npx @sozu/faucet claim ${usdcFaucet.publicKey}`;
    log('FINAL REPORT (BLOCKED)', report);
    process.exit(2);
  }

  const feePayer = loadOrCreateFeePayer();
  await fundWithFriendbot(feePayer.publicKey);
  report.feePayerPublicKey = feePayer.publicKey;

  const aliceOrgId = await createOrg('Alice');
  const bobOrgId = await createOrg('Bob');
  const feeOrgId = await ensureFeeRevenueOrg();
  report.aliceOrgId = aliceOrgId;
  report.bobOrgId = bobOrgId;

  try {
    const aliceWallet = await provisionOrgStellarAccount({
      orgId: aliceOrgId,
      environment: 'test',
      mode: 'live',
    });
    const bobWallet = await provisionOrgStellarAccount({
      orgId: bobOrgId,
      environment: 'test',
      mode: 'live',
    });
    report.alicePublicKey = aliceWallet.publicKey;
    report.bobPublicKey = bobWallet.publicKey;

    if (
      feePayer.publicKey === aliceWallet.publicKey ||
      feePayer.publicKey === bobWallet.publicKey
    ) {
      throw new Error('Fee-payer must not be Alice or Bob');
    }

    await new Promise((r) => setTimeout(r, 2000));

    const fundHash = await fundAliceOnChain({
      fromSecret: usdcFaucet.secret,
      toPublicKey: aliceWallet.publicKey,
      amount: Math.max(PROOF_AMOUNT + 10, 50),
    });
    report.aliceFundHash = fundHash;
    await new Promise((r) => setTimeout(r, 2000));

    const aliceStellarBefore = await stellarBalances(aliceWallet.publicKey);
    const bobStellarBefore = await stellarBalances(bobWallet.publicKey);
    const feePayerBefore = await stellarBalances(feePayer.publicKey);
    report.aliceStellarBefore = aliceStellarBefore;
    report.bobStellarBefore = bobStellarBefore;
    report.feePayerXlmBefore = feePayerBefore.xlm;

    if (aliceStellarBefore.usdc + 1e-7 < PROOF_AMOUNT) {
      report.blocked = true;
      report.blockReason = `Alice Stellar USDC ${aliceStellarBefore.usdc} < ${PROOF_AMOUNT}`;
      log('FINAL REPORT (BLOCKED)', report);
      process.exit(2);
    }

    await creditOrgWallet({
      orgId: aliceOrgId,
      environment: 'test',
      amount: ALICE_LEDGER_SEED,
      idempotencyKey: `eon-proof-alice-${aliceOrgId}`,
    });
    await creditOrgWallet({
      orgId: bobOrgId,
      environment: 'test',
      amount: BOB_LEDGER_SEED,
      idempotencyKey: `eon-proof-bob-${bobOrgId}`,
    });

    const aliceLedgerBefore = await getOrgBalance(aliceOrgId, 'test');
    const bobLedgerBefore = await getOrgBalance(bobOrgId, 'test');
    const feeLedgerBefore = await getOrgBalance(feeOrgId, 'test');
    report.ledgerBefore = {
      alice: aliceLedgerBefore.available,
      bob: bobLedgerBefore.available,
      feeRevenue: feeLedgerBefore.available,
    };

    const idempotencyKey = `eon-proof-xfer-${aliceOrgId}`;
    const transfer = await createInternalTransfer({
      senderOrgId: aliceOrgId,
      environment: 'test',
      amount: PROOF_AMOUNT,
      recipientOrgId: bobOrgId,
      settlementMode: 'STELLAR_ONCHAIN',
      idempotencyKey,
      reason: 'Increment E-ONCHAIN Testnet proof',
    });

    const hash = String(transfer.settlement?.stellarTransactionHash || '');
    report.transfer = {
      transferGroupId: transfer.transferGroupId,
      status: transfer.status,
      stellarTouched: transfer.stellarTouched,
      fee: transfer.fee,
      settlement: transfer.settlement,
    };
    report.stellarTransactionHash = hash;

    const aliceLedgerAfter = await getOrgBalance(aliceOrgId, 'test');
    const bobLedgerAfter = await getOrgBalance(bobOrgId, 'test');
    const feeLedgerAfter = await getOrgBalance(feeOrgId, 'test');
    report.ledgerAfter = {
      alice: aliceLedgerAfter.available,
      bob: bobLedgerAfter.available,
      feeRevenue: feeLedgerAfter.available,
      feeRevenueDelta: feeLedgerAfter.available - feeLedgerBefore.available,
    };

    await new Promise((r) => setTimeout(r, 2000));
    const aliceStellarAfter = await stellarBalances(aliceWallet.publicKey);
    const bobStellarAfter = await stellarBalances(bobWallet.publicKey);
    const feePayerAfter = await stellarBalances(feePayer.publicKey);
    report.aliceStellarAfter = aliceStellarAfter;
    report.bobStellarAfter = bobStellarAfter;
    report.feePayerXlmAfter = feePayerAfter.xlm;
    report.feePayerXlmDelta = feePayerAfter.xlm - feePayerBefore.xlm;
    report.aliceXlmUnchanged =
      Math.abs(aliceStellarAfter.xlm - aliceStellarBefore.xlm) < 1e-7;
    report.bobXlmUnchanged =
      Math.abs(bobStellarAfter.xlm - bobStellarBefore.xlm) < 1e-7;

    const horizon = await verifyFeeBumpOnHorizon(hash, {
      source: aliceWallet.publicKey,
      destination: bobWallet.publicKey,
      amount: PROOF_AMOUNT,
      feePayer: feePayer.publicKey,
    });
    report.horizonVerification = horizon;
    report.actualNetworkFeeStroops = horizon.feeChargedStroops;
    report.actualNetworkFeeXlm = transfer.settlement?.actualNetworkFeeXlm || null;

    const stellarTxCount = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE idempotency_key = $1 AND status = 'confirmed'`,
      [`stellar:internal_transfer:${transfer.transferGroupId}`]
    );
    report.stellarTransactionCount = Number(stellarTxCount.n);

    const senderRecon = await runReconciliation({
      orgId: aliceOrgId,
      environment: 'test',
      transactionIds: [transfer.senderTransactionId!],
      idempotencyKey: `recon-eon-proof-out-${transfer.id}`,
      triggerSource: 'manual',
    });
    report.reconciliation = {
      sender: senderRecon.items[0]?.resultCode,
      status: senderRecon.items[0]?.status,
    };

    const replay = await createInternalTransfer({
      senderOrgId: aliceOrgId,
      environment: 'test',
      amount: PROOF_AMOUNT,
      recipientOrgId: bobOrgId,
      settlementMode: 'STELLAR_ONCHAIN',
      idempotencyKey,
    });
    const aliceReplay = await getOrgBalance(aliceOrgId, 'test');
    const idempotency = {
      duplicate:
        replay.duplicate === true ||
        replay.transferGroupId === transfer.transferGroupId,
      sameHash:
        replay.settlement?.stellarTransactionHash ===
        transfer.settlement?.stellarTransactionHash,
      balanceUnchanged: aliceReplay.available === aliceLedgerAfter.available,
    };
    report.idempotency = idempotency;

    const expectedAliceLedger = ALICE_LEDGER_SEED - PROOF_AMOUNT - FEE_USDC;
    const expectedBobLedger = BOB_LEDGER_SEED + PROOF_AMOUNT;
    const ok =
      transfer.status === 'completed' &&
      horizon.verified === true &&
      Math.abs(aliceLedgerAfter.available - expectedAliceLedger) < 1e-6 &&
      Math.abs(bobLedgerAfter.available - expectedBobLedger) < 1e-6 &&
      Math.abs(feeLedgerAfter.available - feeLedgerBefore.available - FEE_USDC) <
        1e-6 &&
      Math.abs(aliceStellarAfter.usdc - (aliceStellarBefore.usdc - PROOF_AMOUNT)) <
        1e-6 &&
      Math.abs(bobStellarAfter.usdc - (bobStellarBefore.usdc + PROOF_AMOUNT)) <
        1e-6 &&
      report.aliceXlmUnchanged === true &&
      report.bobXlmUnchanged === true &&
      feePayerAfter.xlm < feePayerBefore.xlm &&
      Number(stellarTxCount.n) === 1 &&
      senderRecon.items[0]?.resultCode === 'RECONCILED' &&
      idempotency.sameHash === true &&
      idempotency.balanceUnchanged === true;

    report.pass = ok;
    report.note =
      'Ledger Alice ends at 69.99 (transfer+fee). Stellar Alice decreases by transfer only ($30); Dayfi fee is ledger revenue, not a USDC payment.';
    log('FINAL REPORT', report);
    process.exit(ok ? 0 : 1);
  } finally {
    await db.none(`DELETE FROM infra_organizations WHERE id IN ($1, $2)`, [
      aliceOrgId,
      bobOrgId,
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
