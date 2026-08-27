/**
 * Increment E — Testnet proof: Dayfi → Dayfi ledger transfer.
 *
 * Alice and Bob get real Testnet Stellar wallets. The $30 transfer is
 * ledger-only: Stellar balances must not change.
 *
 * Usage: npm run proof:infra-e-testnet
 */

import StellarSdk from '@stellar/stellar-sdk';
import crypto from 'crypto';
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
import { runReconciliation } from '../src/modules/infra/infraReconciliationService';

configDotenv({ path: path.join(__dirname, '..', '.env') });
configDotenv({ path: path.join(__dirname, '..', '.env.local'), override: true });

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'live';
process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = 'off';
process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = 'off';
process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE = 'off';
delete process.env.USDC_ISSUER;
delete process.env.MASTER_WALLET_PUBLIC_KEY;

const PROOF_AMOUNT = Number(process.env.INFRA_E_PROOF_AMOUNT || '30');
const ALICE_SEED = Number(process.env.INFRA_E_ALICE_SEED || '100');
const BOB_SEED = Number(process.env.INFRA_E_BOB_SEED || '20');

type Report = Record<string, unknown>;

function log(section: string, data: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
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

async function createOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase()}-e-proof-${crypto.randomBytes(4).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`${name} Testnet E Proof`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function main() {
  const report: Report = {
    network: 'testnet',
    proofAmount: PROOF_AMOUNT,
    stellarTouched: false,
  };

  const aliceOrgId = await createOrg('Alice');
  const bobOrgId = await createOrg('Bob');
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

    await new Promise((r) => setTimeout(r, 2000));

    const aliceStellarBefore = await stellarBalances(aliceWallet.publicKey);
    const bobStellarBefore = await stellarBalances(bobWallet.publicKey);
    report.aliceStellarBefore = aliceStellarBefore;
    report.bobStellarBefore = bobStellarBefore;

    await creditOrgWallet({
      orgId: aliceOrgId,
      environment: 'test',
      amount: ALICE_SEED,
      idempotencyKey: `e-proof-alice-${aliceOrgId}`,
    });
    await creditOrgWallet({
      orgId: bobOrgId,
      environment: 'test',
      amount: BOB_SEED,
      idempotencyKey: `e-proof-bob-${bobOrgId}`,
    });

    const aliceLedgerBefore = await getOrgBalance(aliceOrgId, 'test');
    const bobLedgerBefore = await getOrgBalance(bobOrgId, 'test');
    report.ledgerBefore = {
      alice: aliceLedgerBefore.available,
      bob: bobLedgerBefore.available,
      total: aliceLedgerBefore.available + bobLedgerBefore.available,
    };

    const idempotencyKey = `e-proof-xfer-${aliceOrgId}`;
    const transfer = await createInternalTransfer({
      senderOrgId: aliceOrgId,
      environment: 'test',
      amount: PROOF_AMOUNT,
      recipientOrgId: bobOrgId,
      idempotencyKey,
      reason: 'Increment E Testnet proof',
    });
    report.transfer = {
      transferGroupId: transfer.transferGroupId,
      senderTransactionId: transfer.senderTransactionId,
      recipientTransactionId: transfer.recipientTransactionId,
      senderMovementId: transfer.senderMovementId,
      recipientMovementId: transfer.recipientMovementId,
      stellarTouched: transfer.stellarTouched,
    };

    const aliceLedgerAfter = await getOrgBalance(aliceOrgId, 'test');
    const bobLedgerAfter = await getOrgBalance(bobOrgId, 'test');
    report.ledgerAfter = {
      alice: aliceLedgerAfter.available,
      bob: bobLedgerAfter.available,
      total: aliceLedgerAfter.available + bobLedgerAfter.available,
    };

    const aliceStellarAfter = await stellarBalances(aliceWallet.publicKey);
    const bobStellarAfter = await stellarBalances(bobWallet.publicKey);
    report.aliceStellarAfter = aliceStellarAfter;
    report.bobStellarAfter = bobStellarAfter;

    const replay = await createInternalTransfer({
      senderOrgId: aliceOrgId,
      environment: 'test',
      amount: PROOF_AMOUNT,
      recipientOrgId: bobOrgId,
      idempotencyKey,
    });
    const aliceReplay = await getOrgBalance(aliceOrgId, 'test');
    report.idempotency = {
      duplicate: replay.duplicate === true,
      sameGroup: replay.transferGroupId === transfer.transferGroupId,
      balanceUnchanged: aliceReplay.available === aliceLedgerAfter.available,
    };

    let insufficientCode = '';
    const alicePreFail = await getOrgBalance(aliceOrgId, 'test');
    try {
      await createInternalTransfer({
        senderOrgId: aliceOrgId,
        environment: 'test',
        amount: alicePreFail.available + 1000,
        recipientOrgId: bobOrgId,
        idempotencyKey: `e-proof-insuf-${aliceOrgId}`,
      });
    } catch (err: unknown) {
      insufficientCode = (err as { code?: string }).code || 'threw';
    }
    const alicePostFail = await getOrgBalance(aliceOrgId, 'test');
    report.insufficientBalance = {
      code: insufficientCode,
      balanceUnchanged: alicePostFail.available === alicePreFail.available,
    };

    let invalidCode = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceOrgId,
        environment: 'test',
        amount: 1,
        recipientOrgId: crypto.randomUUID(),
      });
    } catch (err: unknown) {
      invalidCode = (err as { code?: string }).code || 'threw';
    }
    report.invalidRecipient = { code: invalidCode };

    await db.none(
      `UPDATE infra_wallet_accounts SET status = 'frozen'
       WHERE org_id = $1 AND environment = 'test'`,
      [bobOrgId]
    );
    const alicePreAtomic = await getOrgBalance(aliceOrgId, 'test');
    const bobPreAtomic = await getOrgBalance(bobOrgId, 'test');
    let atomicFailed = false;
    try {
      await createInternalTransfer({
        senderOrgId: aliceOrgId,
        environment: 'test',
        amount: 1,
        recipientOrgId: bobOrgId,
        idempotencyKey: `e-proof-atomic-${aliceOrgId}`,
      });
    } catch {
      atomicFailed = true;
    }
    await db.none(
      `UPDATE infra_wallet_accounts SET status = 'active'
       WHERE org_id = $1 AND environment = 'test'`,
      [bobOrgId]
    );
    const alicePostAtomic = await getOrgBalance(aliceOrgId, 'test');
    const bobPostAtomic = await getOrgBalance(bobOrgId, 'test');
    report.atomicity = {
      failedAsExpected: atomicFailed,
      aliceUnchanged: alicePostAtomic.available === alicePreAtomic.available,
      bobUnchanged: bobPostAtomic.available === bobPreAtomic.available,
    };

    const senderRecon = await runReconciliation({
      orgId: aliceOrgId,
      environment: 'test',
      transactionIds: [transfer.senderTransactionId!],
      idempotencyKey: `recon-e-proof-out-${transfer.id}`,
      triggerSource: 'test',
    });
    const recipientRecon = await runReconciliation({
      orgId: bobOrgId,
      environment: 'test',
      transactionIds: [transfer.recipientTransactionId!],
      idempotencyKey: `recon-e-proof-in-${transfer.id}`,
      triggerSource: 'test',
    });
    report.reconciliation = {
      sender: {
        status: senderRecon.items[0]?.status,
        resultCode: senderRecon.items[0]?.resultCode,
        settlementRequired: senderRecon.items[0]?.settlement?.required,
      },
      recipient: {
        status: recipientRecon.items[0]?.status,
        resultCode: recipientRecon.items[0]?.resultCode,
        settlementRequired: recipientRecon.items[0]?.settlement?.required,
      },
    };

    const settlementCount = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE org_id IN ($1, $2)`,
      [aliceOrgId, bobOrgId]
    );
    report.stellarSettlementsCreated = Number(settlementCount.n);

    const stellarUnchanged =
      aliceStellarBefore.usdc === aliceStellarAfter.usdc &&
      bobStellarBefore.usdc === bobStellarAfter.usdc &&
      Math.abs(aliceStellarBefore.xlm - aliceStellarAfter.xlm) < 0.0000001 &&
      Math.abs(bobStellarBefore.xlm - bobStellarAfter.xlm) < 0.0000001;

    report.successPath = {
      pass:
        transfer.stellarTouched === false &&
        Number(settlementCount.n) === 0 &&
        stellarUnchanged &&
        Math.abs(aliceLedgerAfter.available - (aliceLedgerBefore.available - PROOF_AMOUNT)) <
          0.01 &&
        Math.abs(bobLedgerAfter.available - (bobLedgerBefore.available + PROOF_AMOUNT)) < 0.01 &&
        Math.abs(
          aliceLedgerAfter.available +
            bobLedgerAfter.available -
            (aliceLedgerBefore.available + bobLedgerBefore.available)
        ) < 0.01 &&
        (report.idempotency as { sameGroup?: boolean }).sameGroup === true &&
        (report.insufficientBalance as { code?: string }).code === 'INSUFFICIENT_BALANCE' &&
        (report.invalidRecipient as { code?: string }).code === 'UNKNOWN_RECIPIENT' &&
        (report.atomicity as { failedAsExpected?: boolean }).failedAsExpected === true &&
        senderRecon.items[0]?.status === 'reconciled' &&
        recipientRecon.items[0]?.status === 'reconciled' &&
        senderRecon.items[0]?.settlement?.required === false,
    };

    log('FINAL REPORT', report);
    const ok = (report.successPath as { pass?: boolean })?.pass === true;
    process.exit(ok ? 0 : 1);
  } finally {
    await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [aliceOrgId]).catch(() => {});
    await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [bobOrgId]).catch(() => {});
  }
}

main().catch((err) => {
  console.error('Proof failed:', err);
  process.exit(1);
});
