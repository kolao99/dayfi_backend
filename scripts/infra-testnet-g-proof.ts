/**
 * Increment G — Testnet proof: treasury liquidity observation + manual rebalance.
 *
 * Usage: npm run proof:infra-g-testnet
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
  settleFiatOfframp,
  retryFiatOfframpProvider,
} from '../src/modules/infra/infraFiatWithdrawalService';
import { getDayfiTreasuryPublicKey } from '../src/modules/infra/infraStellarFundingService';
import {
  executeTreasuryRebalance,
  getTreasuryPosition,
  reconcileTreasuryPosition,
} from '../src/modules/infra/infraTreasuryService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local'), override: true });

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock';
process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'live';
process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
process.env.DAYFI_TREASURY_REBALANCE_OPEN = 'true';
delete process.env.USDC_ISSUER;
delete process.env.MASTER_WALLET_PUBLIC_KEY;
delete process.env.DAYFI_TREASURY_FROZEN;
delete process.env.DAYFI_TREASURY_MOCK_USDC;

const SENDER_FILE = path.join(__dirname, '..', '.testnet-deposit-sender.local.json');
const FEE_PAYER_FILE = path.join(
  __dirname,
  '..',
  '.testnet-e-onchain-fee-payer.local.json'
);
const TREASURY_FILE = path.join(__dirname, '..', '.testnet-treasury.local.json');
const SECONDARY_FILE = path.join(
  __dirname,
  '..',
  '.testnet-treasury-b.local.json'
);

const H_AMOUNT = Number(process.env.INFRA_G_H_AMOUNT || '5');
const REBALANCE_AMOUNT = Number(process.env.INFRA_G_REBALANCE_AMOUNT || '1');
const LEDGER_SEED = Number(process.env.INFRA_G_LEDGER_SEED || '50');

type Report = Record<string, unknown>;

function log(section: string, data: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function loadOrCreateKeypair(
  file: string,
  envSecretKey?: string,
  envPkKey?: string
) {
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

async function ensureUsdcTrustline(secret: string): Promise<void> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const issuer = resolveUsdcIssuer(true);
  const asset = new StellarSdk.Asset('USDC', issuer);
  const account = await server.loadAccount(kp.publicKey());
  const has = (
    account.balances as { asset_code?: string; asset_issuer?: string }[]
  ).some((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
  if (has) return;
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({ asset, limit: '1000000000' })
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
  await new Promise((r) => setTimeout(r, 1500));
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

async function fundUsdc(input: {
  fromSecret: string;
  toPublicKey: string;
  amount: number;
}): Promise<string> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const kp = StellarSdk.Keypair.fromSecret(input.fromSecret);
  const asset = new StellarSdk.Asset('USDC', resolveUsdcIssuer(true));
  const account = await server.loadAccount(kp.publicKey());
  const amt = (Math.round(input.amount * 1e7) / 1e7)
    .toFixed(7)
    .replace(/\.?0+$/, '');
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

async function main() {
  const report: Report = {
    increment: 'G',
    network: 'testnet',
    hAmount: H_AMOUNT,
    rebalanceAmount: REBALANCE_AMOUNT,
    providerLeg: 'simulated',
    stellarLeg: 'live',
    pass: false,
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
  await ensureUsdcTrustline(treasury.secret);

  const secondary = loadOrCreateKeypair(SECONDARY_FILE);
  process.env.DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY = secondary.publicKey;
  await fundWithFriendbot(secondary.publicKey);
  await ensureUsdcTrustline(secondary.secret);

  report.treasuryPublicKey = getDayfiTreasuryPublicKey() || treasury.publicKey;
  report.secondaryPublicKey = secondary.publicKey;
  report.feePayerPublicKey = feePayer.publicKey;

  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [
      'Alice Testnet G Proof',
      `alice-g-proof-${crypto.randomBytes(4).toString('hex')}`,
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

    let aliceStellarBefore = await stellarBalances(aliceWallet.publicKey);
    const faucetBal = await stellarBalances(faucet.publicKey);
    const need = Math.max(H_AMOUNT + 2, 10);

    if (aliceStellarBefore.usdc + 1e-7 < H_AMOUNT) {
      if (faucetBal.usdc + 1e-7 >= need) {
        report.aliceFundSource = 'deposit_sender';
        report.aliceFundHash = await fundUsdc({
          fromSecret: faucet.secret,
          toPublicKey: aliceWallet.publicKey,
          amount: need,
        });
      } else {
        // Bootstrap from Dayfi treasury when Sozu faucet is on cooldown.
        const treasuryBal = await stellarBalances(treasury.publicKey);
        if (treasuryBal.usdc + 1e-7 < need) {
          report.blocked = true;
          report.blockReason = `Need ${need} USDC to fund Alice; faucet has ${faucetBal.usdc}, treasury has ${treasuryBal.usdc}. Fund via: npx @sozu/faucet claim ${faucet.publicKey}`;
          log('FINAL REPORT (BLOCKED)', report);
          process.exit(2);
        }
        report.aliceFundSource = 'treasury_bootstrap';
        report.aliceFundHash = await fundUsdc({
          fromSecret: treasury.secret,
          toPublicKey: aliceWallet.publicKey,
          amount: need,
        });
      }
      await new Promise((r) => setTimeout(r, 2500));
      aliceStellarBefore = await stellarBalances(aliceWallet.publicKey);
    }

    const treasuryBefore = await stellarBalances(String(report.treasuryPublicKey));
    const secondaryBefore = await stellarBalances(secondary.publicKey);

    if (aliceStellarBefore.usdc + 1e-7 < H_AMOUNT) {
      report.blocked = true;
      report.blockReason = `Alice Stellar USDC ${aliceStellarBefore.usdc} < ${H_AMOUNT}`;
      log('FINAL REPORT (BLOCKED)', report);
      process.exit(2);
    }

    await creditOrgWallet({
      orgId: org.id,
      environment: 'test',
      amount: LEDGER_SEED,
      idempotencyKey: `g-proof-seed-${org.id}`,
    });

    const positionBefore = await getTreasuryPosition({ environment: 'test' });
    report.before = {
      treasuryUsdc: treasuryBefore.usdc,
      aliceStellarUsdc: aliceStellarBefore.usdc,
      secondaryUsdc: secondaryBefore.usdc,
      aliceLedger: await getOrgBalance(org.id, 'test'),
      position: {
        status: positionBefore.status,
        onChainBalance: positionBefore.usdc.onChainBalance,
        customerLiability: positionBefore.usdc.customerLiability,
        liquidityGap: positionBefore.usdc.liquidityGap,
        coverageRatio: positionBefore.usdc.coverageRatio,
        customerCustodyCountedAsTreasury:
          positionBefore.customerCustody.countedAsTreasury,
      },
    };
    log('BEFORE', report.before);

    const payout = await createPayout({
      orgId: org.id,
      env: 'test',
      amount: H_AMOUNT,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice G',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `g-proof-h-${org.id}`,
    });

    process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL = '1';
    const failed = await settleFiatOfframp({
      orgId: org.id,
      payoutTransactionId: payout.id,
    });
    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;

    const treasuryAfterFail = await stellarBalances(String(report.treasuryPublicKey));
    const positionFail = await getTreasuryPosition({ environment: 'test' });
    report.hProviderFail = {
      status: failed.status,
      stellarHash: failed.stellar?.externalReference,
      treasuryDelta: treasuryAfterFail.usdc - treasuryBefore.usdc,
      providerRetryRequired:
        Number(positionFail.obligations.pendingProviderRetryRequired) >=
        H_AMOUNT - 1e-6,
      explorerUrl: failed.stellar?.externalReference
        ? `https://stellar.expert/explorer/testnet/tx/${failed.stellar.externalReference}`
        : null,
    };
    log('H PROVIDER FAIL', report.hProviderFail);

    const retried = await retryFiatOfframpProvider({
      orgId: org.id,
      payoutTransactionId: payout.id,
    });
    report.hProviderRetry = {
      status: retried.status,
      sameStellarHash:
        retried.stellar?.externalReference ===
        failed.stellar?.externalReference,
      providerRef:
        retried.provider?.providerReference ||
        retried.provider?.externalReference,
    };
    log('H PROVIDER RETRY', report.hProviderRetry);

    const treasuryBeforeRb = await stellarBalances(String(report.treasuryPublicKey));
    if (treasuryBeforeRb.usdc < REBALANCE_AMOUNT + 0.5) {
      report.blocked = true;
      report.blockReason = `Treasury USDC ${treasuryBeforeRb.usdc} too low for rebalance`;
      log('FINAL REPORT (BLOCKED)', report);
      process.exit(2);
    }

    const rebalanceKey = `treasury:rebalance:g-proof:${org.id}`;
    const rebalance = await executeTreasuryRebalance({
      environment: 'test',
      amount: REBALANCE_AMOUNT,
      destinationPublicKey: secondary.publicKey,
      idempotencyKey: rebalanceKey,
      requestedBy: 'g-proof',
      purpose: 'manual_testnet_proof',
    });
    const replay = await executeTreasuryRebalance({
      environment: 'test',
      amount: REBALANCE_AMOUNT,
      destinationPublicKey: secondary.publicKey,
      idempotencyKey: rebalanceKey,
      requestedBy: 'g-proof',
    });

    await new Promise((r) => setTimeout(r, 3000));
    const treasuryAfterRb = await stellarBalances(String(report.treasuryPublicKey));
    const secondaryAfter = await stellarBalances(secondary.publicKey);
    const aliceLedgerAfter = await getOrgBalance(org.id, 'test');
    const positionAfter = await getTreasuryPosition({ environment: 'test' });
    const recon = await reconcileTreasuryPosition({ environment: 'test' });

    report.rebalance = {
      status: rebalance.status,
      hash: rebalance.stellarTransactionHash,
      feeXlm:
        rebalance.actualNetworkFeeXlm ||
        rebalance.railMetadata?.actualNetworkFeeXlm,
      treasuryDelta: treasuryAfterRb.usdc - treasuryBeforeRb.usdc,
      secondaryDelta: secondaryAfter.usdc - secondaryBefore.usdc,
      idempotentSameHash:
        replay.stellarTransactionHash === rebalance.stellarTransactionHash,
      aliceLedgerUnchanged:
        Math.abs(aliceLedgerAfter.available - (LEDGER_SEED - H_AMOUNT)) < 1e-6,
      explorerUrl: rebalance.stellarTransactionHash
        ? `https://stellar.expert/explorer/testnet/tx/${rebalance.stellarTransactionHash}`
        : null,
    };
    log('REBALANCE', report.rebalance);

    report.after = {
      treasuryUsdc: treasuryAfterRb.usdc,
      secondaryUsdc: secondaryAfter.usdc,
      aliceStellar: await stellarBalances(aliceWallet.publicKey),
      aliceLedger: aliceLedgerAfter,
      position: {
        status: positionAfter.status,
        onChainBalance: positionAfter.usdc.onChainBalance,
        customerLiability: positionAfter.usdc.customerLiability,
        liquidityGap: positionAfter.usdc.liquidityGap,
        coverageRatio: positionAfter.usdc.coverageRatio,
      },
      reconciliation: {
        resultCode: recon.resultCode,
        status: recon.status,
      },
    };
    log('AFTER', report.after);

    const ok =
      failed.status === 'provider_retry_required' &&
      Math.abs(
        (report.hProviderFail as { treasuryDelta: number }).treasuryDelta -
          H_AMOUNT
      ) < 1e-5 &&
      (report.hProviderFail as { providerRetryRequired: boolean })
        .providerRetryRequired === true &&
      retried.status === 'completed' &&
      (report.hProviderRetry as { sameStellarHash: boolean }).sameStellarHash ===
        true &&
      rebalance.status === 'confirmed' &&
      Boolean(rebalance.stellarTransactionHash) &&
      (report.rebalance as { idempotentSameHash: boolean }).idempotentSameHash ===
        true &&
      Math.abs(
        (report.rebalance as { secondaryDelta: number }).secondaryDelta -
          REBALANCE_AMOUNT
      ) < 1e-5 &&
      Math.abs(
        (report.rebalance as { treasuryDelta: number }).treasuryDelta +
          REBALANCE_AMOUNT
      ) < 1e-5 &&
      (report.rebalance as { aliceLedgerUnchanged: boolean })
        .aliceLedgerUnchanged === true &&
      positionBefore.customerCustody.countedAsTreasury === false;

    report.pass = ok;
    report.note =
      'Live Testnet: Horizon treasury observation, Alice→treasury (H), Provider simulated fail/retry, manual treasury→treasury rebalance. Customer wallets excluded from treasury liquidity.';
    log('FINAL REPORT', report);
    if (!ok) process.exitCode = 1;
  } catch (err: any) {
    report.pass = false;
    report.error = err?.message || String(err);
    log('FINAL REPORT (ERROR)', report);
    process.exitCode = 1;
  } finally {
    await db.$pool.end().catch(() => undefined);
  }
}

main();
