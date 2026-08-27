/**
 * Phase 1 infra ledger tests.
 *
 * Requires Postgres with infra wallet/ledger migrations applied.
 * Run: npm run test:infra-ledger
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  debitOrgWallet,
  getOrgBalance,
  InfraLedgerError,
} from '../../src/modules/infra/infraLedgerService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `ledger-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Ledger Test ${suffix}`, slug]
  );
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra ledger (Phase 1)', function () {
  this.timeout(20000);

  let orgA: string;
  let orgB: string;

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_wallet_accounts') AS t`
    );
    if (!reg?.t) {
      throw new Error(
        'infra_wallet_accounts missing — run migrations before test:infra-ledger'
      );
    }
    orgA = await createTestOrg('a');
    orgB = await createTestOrg('b');
    await bootstrapOrgWallets(orgA);
    await bootstrapOrgWallets(orgB);
  });

  after(async () => {
    if (orgA) await cleanupOrg(orgA);
    if (orgB) await cleanupOrg(orgB);
  });

  it('bootstraps a TEST/USDC wallet with zero balances', async () => {
    const bal = await getOrgBalance(orgA, 'test', 'USDC');
    expect(bal.environment).to.equal('test');
    expect(bal.asset).to.equal('USDC');
    expect(bal.available).to.equal(0);
    expect(bal.pending).to.equal(0);
    expect(bal.locked).to.equal(0);
  });

  it('credits available balance', async () => {
    const key = `credit-${orgA}-${crypto.randomUUID()}`;
    const mv = await creditOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 100,
      idempotencyKey: key,
      movementType: 'test_credit',
    });
    expect(mv.duplicate).to.equal(false);
    expect(Number(mv.available_after)).to.equal(100);

    const bal = await getOrgBalance(orgA, 'test');
    expect(bal.available).to.equal(100);
  });

  it('debits available balance', async () => {
    const key = `debit-${orgA}-${crypto.randomUUID()}`;
    const mv = await debitOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 40,
      idempotencyKey: key,
    });
    expect(mv.duplicate).to.equal(false);
    expect(Number(mv.available_after)).to.equal(60);

    const bal = await getOrgBalance(orgA, 'test');
    expect(bal.available).to.equal(60);
  });

  it('rejects insufficient balance', async () => {
    let err: unknown;
    try {
      await debitOrgWallet({
        orgId: orgA,
        environment: 'test',
        amount: 999999,
        idempotencyKey: `insuf-${crypto.randomUUID()}`,
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(InfraLedgerError);
    expect((err as InfraLedgerError).code).to.equal('INSUFFICIENT_BALANCE');

    const bal = await getOrgBalance(orgA, 'test');
    expect(bal.available).to.equal(60);
  });

  it('is idempotent on duplicate credit key', async () => {
    const key = `idem-credit-${orgA}`;
    const first = await creditOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 10,
      idempotencyKey: key,
    });
    const second = await creditOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 10,
      idempotencyKey: key,
    });
    expect(first.duplicate).to.equal(false);
    expect(second.duplicate).to.equal(true);
    expect(second.id).to.equal(first.id);

    const bal = await getOrgBalance(orgA, 'test');
    expect(bal.available).to.equal(70);
  });

  it('is idempotent on duplicate debit key', async () => {
    const key = `idem-debit-${orgA}`;
    const first = await debitOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 5,
      idempotencyKey: key,
    });
    const second = await debitOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 5,
      idempotencyKey: key,
    });
    expect(first.duplicate).to.equal(false);
    expect(second.duplicate).to.equal(true);

    const bal = await getOrgBalance(orgA, 'test');
    expect(bal.available).to.equal(65);
  });

  it('isolates organizations', async () => {
    await creditOrgWallet({
      orgId: orgB,
      environment: 'test',
      amount: 25,
      idempotencyKey: `orgb-${crypto.randomUUID()}`,
    });
    const a = await getOrgBalance(orgA, 'test');
    const b = await getOrgBalance(orgB, 'test');
    expect(a.available).to.equal(65);
    expect(b.available).to.equal(25);
  });

  it('isolates TEST vs LIVE environments', async () => {
    await creditOrgWallet({
      orgId: orgA,
      environment: 'live',
      amount: 15,
      idempotencyKey: `live-${orgA}-${crypto.randomUUID()}`,
    });
    const testBal = await getOrgBalance(orgA, 'test');
    const liveBal = await getOrgBalance(orgA, 'live');
    expect(testBal.available).to.equal(65);
    expect(liveBal.available).to.equal(15);
  });

  it('handles concurrent credits without losing funds', async () => {
    const before = await getOrgBalance(orgB, 'test');
    const n = 20;
    const amount = 1;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        creditOrgWallet({
          orgId: orgB,
          environment: 'test',
          amount,
          idempotencyKey: `concurrent-credit-${orgB}-${i}-${crypto.randomUUID()}`,
        })
      )
    );
    const after = await getOrgBalance(orgB, 'test');
    expect(after.available).to.equal(before.available + n * amount);
  });

  it('handles concurrent debits without going negative', async () => {
    const org = await createTestOrg('concurrent-debit');
    try {
      await creditOrgWallet({
        orgId: org,
        environment: 'test',
        amount: 50,
        idempotencyKey: `seed-${org}`,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          debitOrgWallet({
            orgId: org,
            environment: 'test',
            amount: 5,
            idempotencyKey: `concurrent-debit-${org}-${i}`,
          })
        )
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected').length;
      expect(fulfilled).to.equal(10);
      expect(rejected).to.equal(10);

      const bal = await getOrgBalance(org, 'test');
      expect(bal.available).to.equal(0);
    } finally {
      await cleanupOrg(org);
    }
  });
});
