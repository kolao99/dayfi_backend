/**
 * Phase 6 — Reconciliation (observe provider + ledger + settlement).
 *
 * Run: npm run test:infra-reconciliation
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
} from '../../src/modules/infra/infraLedgerService';
import { settleCollectionCredit } from '../../src/modules/infra/infraLifecycleService';
import { createPayout } from '../../src/modules/infra/infraMoneyService';
import { settlePayoutOnStellar } from '../../src/modules/infra/infraSettlementService';
import {
  getReconciliationForTransaction,
  getReconciliationOverview,
  runReconciliation,
} from '../../src/modules/infra/infraReconciliationService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `recon-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Recon Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

async function insertPayment(
  orgId: string,
  amount: number,
  opts?: { status?: string; withExternal?: boolean }
): Promise<string> {
  const status = opts?.status || 'pending';
  const externalId =
    opts?.withExternal === false
      ? null
      : `yc_${crypto.randomBytes(6).toString('hex')}`;
  const row = await db.one<{ id: string }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
     VALUES ($1, 'test', $2, 'USDC', $3, 'bank_transfer', 'payment', 0, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [
      orgId,
      amount,
      status,
      externalId,
      JSON.stringify({
        type: 'collection',
        usdcAmount: amount,
        provider: 'yellowcard',
        providerEventId: externalId,
        settlementSource: 'yellowcard',
      }),
    ]
  );
  return row.id;
}

describe('infra reconciliation (Phase 6)', function () {
  this.timeout(60000);
  let orgId: string;

  before(async () => {
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_reconciliation_runs') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-reconciliation');
    }
    orgId = await createTestOrg('main');
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 5000,
      idempotencyKey: `recon-seed-${orgId}`,
    });
  });

  after(async () => {
    if (orgId) await cleanupOrg(orgId);
  });

  it('marks a settled collection RECONCILED when provider + ledger match', async () => {
    const paymentId = await insertPayment(orgId, 100);
    await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `yc:credit:${paymentId}`,
      source: 'test',
    });

    const result = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: `recon-ok-${paymentId}`,
      triggerSource: 'test',
    });

    expect(result.duplicate).to.equal(false);
    expect(result.items).to.have.length(1);
    const item = result.items[0];
    expect(item.status).to.equal('reconciled');
    expect(item.resultCode).to.equal('RECONCILED');
    expect(item.provider.present).to.equal(true);
    expect(item.ledger.present).to.equal(true);
    expect(item.settlement.required).to.equal(false);
    expect(item.legs.result.code).to.equal('RECONCILED');
  });

  it('classifies AMOUNT_MISMATCH when ledger and expected amounts differ', async () => {
    const paymentId = await insertPayment(orgId, 200);
    await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `yc:credit:${paymentId}`,
      source: 'test',
    });

    await db.none(
      `UPDATE infra_transactions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [paymentId, JSON.stringify({ usdcAmount: 190 })]
    );

    const result = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: `recon-amt-${paymentId}`,
      triggerSource: 'test',
    });

    expect(result.items[0].status).to.equal('mismatch');
    expect(result.items[0].resultCode).to.equal('AMOUNT_MISMATCH');
    expect(result.items[0].mismatches).to.include('AMOUNT_MISMATCH');
  });

  it('classifies MISSING_LEDGER when provider is present but ledger is not', async () => {
    const paymentId = await insertPayment(orgId, 50, { status: 'settled' });

    const result = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: `recon-nolegder-${paymentId}`,
      triggerSource: 'test',
    });

    expect(result.items[0].status).to.equal('incomplete');
    expect(result.items[0].resultCode).to.equal('MISSING_LEDGER');
    expect(result.items[0].provider.present).to.equal(true);
    expect(result.items[0].ledger.present).to.equal(false);
  });

  it('reconciles a Stellar-settled payout (provider + ledger + settlement)', async () => {
    const dest = StellarSdk.Keypair.random().publicKey();
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 25,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: dest,
      accountName: 'Recon Dest',
    });

    await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });

    const result = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [payout.id],
      idempotencyKey: `recon-stellar-${payout.id}`,
      triggerSource: 'test',
    });

    expect(result.items[0].status).to.equal('reconciled');
    expect(result.items[0].resultCode).to.equal('RECONCILED');
    expect(result.items[0].settlement.required).to.equal(true);
    expect(result.items[0].settlement.present).to.equal(true);
    expect(result.items[0].ledger.present).to.equal(true);
  });

  it('is idempotent for the same idempotency key', async () => {
    const paymentId = await insertPayment(orgId, 15);
    await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `yc:credit:${paymentId}`,
      source: 'test',
    });

    const key = `recon-idem-${paymentId}`;
    const first = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: key,
      triggerSource: 'test',
    });
    const second = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: key,
      triggerSource: 'test',
    });

    expect(second.duplicate).to.equal(true);
    expect(second.run.id).to.equal(first.run.id);
    expect(second.items[0].resultCode).to.equal('RECONCILED');
  });

  it('exposes overview + per-transaction explanation without moving money', async () => {
    const before = await getOrgBalance(orgId, 'test');
    const paymentId = await insertPayment(orgId, 10);
    await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `yc:credit:${paymentId}`,
      source: 'test',
    });
    await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: `recon-overview-${paymentId}`,
      triggerSource: 'test',
    });

    const overview = await getReconciliationOverview(orgId, 'test');
    expect(overview.matchedPct).to.not.equal(null);
    expect(overview.rows.length).to.be.greaterThan(0);

    const detail = await getReconciliationForTransaction(orgId, paymentId);
    expect(detail.check.resultCode).to.be.a('string');
    expect(detail.check.legs).to.have.property('provider');
    expect(detail.check.legs).to.have.property('ledger');
    expect(detail.check.legs).to.have.property('settlement');

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available + 10);
    expect(after.locked).to.equal(before.locked);
  });
});
