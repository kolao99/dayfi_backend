/**
 * Phase 2 infra money lifecycle tests.
 * Collect credits only on settlement; Send locks then finalizes/releases.
 *
 * Run: npm run test:infra-lifecycle
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
  InfraLedgerError,
} from '../../src/modules/infra/infraLedgerService';
import {
  finalizePayoutDebit,
  InfraLifecycleError,
  lockPayoutFunds,
  releasePayoutLock,
  settleCollectionCredit,
} from '../../src/modules/infra/infraLifecycleService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `life-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Lifecycle Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

async function insertPayment(orgId: string, amount = 650): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
     VALUES ($1, 'test', $2, 'USDC', 'pending', 'bank_transfer', 'payment', 0, $3, $4::jsonb)
     RETURNING id::text AS id`,
    [
      orgId,
      Math.round(amount),
      `seq-pay-${crypto.randomUUID()}`,
      JSON.stringify({ type: 'collection', usdcAmount: amount }),
    ]
  );
  return row.id;
}

async function insertPayout(orgId: string, amount = 200): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
     VALUES ($1, 'test', $2, 'USDC', 'processing', 'bank_transfer', 'payout', 0, $3, $4::jsonb)
     RETURNING id::text AS id`,
    [
      orgId,
      Math.round(amount),
      `seq-out-${crypto.randomUUID()}`,
      JSON.stringify({ type: 'payout', usdcAmount: amount }),
    ]
  );
  return row.id;
}

describe('infra lifecycle (Phase 2)', function () {
  this.timeout(30000);
  let orgId: string;

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_ledger_movements') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-lifecycle');
    }
    // Ensure Phase 2 columns exist
    await db.none(
      `ALTER TABLE infra_ledger_movements
         ADD COLUMN IF NOT EXISTS reference_type VARCHAR(64),
         ADD COLUMN IF NOT EXISTS reference_id VARCHAR(255)`
    );
    orgId = await createTestOrg('main');
  });

  after(async () => {
    if (orgId) await cleanupOrg(orgId);
  });

  it('does not invent money on collection create (intent only)', async () => {
    const before = await getOrgBalance(orgId, 'test');
    await insertPayment(orgId, 100);
    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available);
  });

  it('credits available only after verified collection settlement', async () => {
    const paymentId = await insertPayment(orgId, 650);
    const before = await getOrgBalance(orgId, 'test');

    const first = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-credit-${paymentId}`,
      source: 'test',
    });
    expect(first.credit.duplicate).to.equal(false);
    expect(first.usdcAmount).to.equal(650);
    expect(first.balance.available).to.equal(before.available + 650);

    const second = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-credit-${paymentId}`,
      source: 'test',
    });
    expect(second.credit.duplicate).to.equal(true);
    expect(second.balance.available).to.equal(before.available + 650);
  });

  it('does not double-credit the same collection for two success event ids', async () => {
    const paymentId = await insertPayment(orgId, 400);
    const before = await getOrgBalance(orgId, 'test');

    const first = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-a-${paymentId}`,
      source: 'test',
    });
    expect(first.credit.duplicate).to.equal(false);

    const second = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-b-${paymentId}`,
      source: 'test',
    });
    expect(second.credit.duplicate).to.equal(true);
    expect(second.balance.available).to.equal(before.available + 400);
  });

  it('locks funds on payout without permanently debiting', async () => {
    // Seed available
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 1000,
      idempotencyKey: `seed-${orgId}-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgId, 'test');
    const payoutId = await insertPayout(orgId, 200);

    const locked = await lockPayoutFunds({ orgId, transactionId: payoutId });
    expect(locked.lock.duplicate).to.equal(false);
    expect(locked.balance.available).to.equal(before.available - 200);
    expect(locked.balance.locked).to.equal(before.locked + 200);

    // Idempotent lock
    const again = await lockPayoutFunds({ orgId, transactionId: payoutId });
    expect(again.lock.duplicate).to.equal(true);
    expect(again.balance.available).to.equal(before.available - 200);
    expect(again.balance.locked).to.equal(before.locked + 200);
  });

  it('rejects lock when available is insufficient', async () => {
    const org = await createTestOrg('poor');
    try {
      const payoutId = await insertPayout(org, 50);
      let err: unknown;
      try {
        await lockPayoutFunds({ orgId: org, transactionId: payoutId });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(InfraLedgerError);
      expect((err as InfraLedgerError).code).to.equal('INSUFFICIENT_BALANCE');
    } finally {
      await cleanupOrg(org);
    }
  });

  it('finalizes locked payout (available unchanged, locked cleared)', async () => {
    const org = await createTestOrg('finalize');
    try {
      await creditOrgWallet({
        orgId: org,
        environment: 'test',
        amount: 500,
        idempotencyKey: `seed-fin-${org}`,
      });
      const payoutId = await insertPayout(org, 120);
      await lockPayoutFunds({ orgId: org, transactionId: payoutId });
      const mid = await getOrgBalance(org, 'test');

      const fin = await finalizePayoutDebit({
        orgId: org,
        transactionId: payoutId,
        providerEventId: `fin-${payoutId}`,
        source: 'test',
      });
      expect(fin.finalize.duplicate).to.equal(false);
      expect(fin.balance.available).to.equal(mid.available);
      expect(fin.balance.locked).to.equal(mid.locked - 120);

      const again = await finalizePayoutDebit({
        orgId: org,
        transactionId: payoutId,
        providerEventId: `fin-${payoutId}`,
        source: 'test',
      });
      expect(again.finalize.duplicate).to.equal(true);

      const otherEvent = await finalizePayoutDebit({
        orgId: org,
        transactionId: payoutId,
        providerEventId: `fin-other-${payoutId}`,
        source: 'test',
      });
      expect(otherEvent.finalize.duplicate).to.equal(true);
      expect(otherEvent.balance.locked).to.equal(mid.locked - 120);
    } finally {
      await cleanupOrg(org);
    }
  });

  it('releases lock on payout failure (restores available)', async () => {
    const org = await createTestOrg('release');
    try {
      await creditOrgWallet({
        orgId: org,
        environment: 'test',
        amount: 300,
        idempotencyKey: `seed-rel-${org}`,
      });
      const before = await getOrgBalance(org, 'test');
      const payoutId = await insertPayout(org, 75);
      await lockPayoutFunds({ orgId: org, transactionId: payoutId });

      const released = await releasePayoutLock({
        orgId: org,
        transactionId: payoutId,
        providerEventId: `rel-${payoutId}`,
        source: 'test',
      });
      expect(released.release.duplicate).to.equal(false);
      expect(released.balance.available).to.equal(before.available);
      expect(released.balance.locked).to.equal(before.locked);

      try {
        await finalizePayoutDebit({
          orgId: org,
          transactionId: payoutId,
          providerEventId: 'late-success',
          source: 'test',
        });
        expect.fail('finalize after release should be refused');
      } catch (err) {
        expect(err).to.be.instanceOf(InfraLifecycleError);
        expect((err as InfraLifecycleError).code).to.equal('PAYOUT_ALREADY_RELEASED');
      }
      const after = await getOrgBalance(org, 'test');
      expect(after.available).to.equal(before.available);
    } finally {
      await cleanupOrg(org);
    }
  });
});
