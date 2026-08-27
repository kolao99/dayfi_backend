/**
 * P1 money-integrity blockers for real funds:
 * economic idempotency (covered in lifecycle), decimals, create Idempotency-Key, LIVE KYC.
 *
 * Run: npm run test:infra-p1
 */

import { expect } from 'chai';
import { describe, it, before, after, afterEach } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
} from '../../src/modules/infra/infraLedgerService';
import {
  createCollection,
  createPayout,
  InfraIdempotencyError,
  InfraRailError,
} from '../../src/modules/infra/infraMoneyService';
import YellowCardService from '../../src/modules/payment/yellowCardService';

const ycProto = YellowCardService.prototype;
const ycConfigured = ycProto.isConfigured;

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `p1-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`P1 Money ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  await db.none(
    `INSERT INTO infra_members (org_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', 'P1 Tester', 'admin')`,
    [org.id, `p1-${suffix}-${crypto.randomBytes(4).toString('hex')}@dayfi.test`]
  );
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra P1 money integrity', function () {
  this.timeout(60000);
  let orgId: string;

  before(async () => {
    await db.none(
      `ALTER TABLE infra_transactions
         ALTER COLUMN amount TYPE NUMERIC(28, 7) USING amount::numeric,
         ALTER COLUMN fee TYPE NUMERIC(28, 7) USING fee::numeric`
    );
    await db.none(
      `ALTER TABLE infra_transactions
         ADD COLUMN IF NOT EXISTS client_idempotency_key VARCHAR(255),
         ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64)`
    );
    await db.none(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_tx_org_env_idempotency
         ON infra_transactions (org_id, environment, client_idempotency_key)
         WHERE client_idempotency_key IS NOT NULL`
    );
    orgId = await createTestOrg('main');
  });

  after(async () => {
    ycProto.isConfigured = ycConfigured;
    if (orgId) await cleanupOrg(orgId);
  });

  afterEach(() => {
    ycProto.isConfigured = ycConfigured;
  });

  it('persists fractional USDC instead of Math.round to an integer', async () => {
    const created = await createCollection({
      orgId,
      env: 'test',
      amount: 10.4,
      method: 'crypto',
      asset: 'USDC',
      network: 'stellar',
    });
    const row = await db.one<{ amount: string }>(
      `SELECT amount::text AS amount FROM infra_transactions WHERE id = $1`,
      [created.id]
    );
    expect(Number(row.amount)).to.equal(10.4);
    expect(created.amount).to.equal(10.4);
  });

  it('replays the same Idempotency-Key and rejects a conflicting payload', async () => {
    const key = `p1-col-${crypto.randomUUID()}`;
    const first = await createCollection({
      orgId,
      env: 'test',
      amount: 25.25,
      method: 'crypto',
      asset: 'USDC',
      idempotencyKey: key,
    });
    const second = await createCollection({
      orgId,
      env: 'test',
      amount: 25.25,
      method: 'crypto',
      asset: 'USDC',
      idempotencyKey: key,
    });
    expect(second.id).to.equal(first.id);
    expect((second as { idempotentReplay?: boolean }).idempotentReplay).to.equal(true);

    try {
      await createCollection({
        orgId,
        env: 'test',
        amount: 50,
        method: 'crypto',
        asset: 'USDC',
        idempotencyKey: key,
      });
      expect.fail('conflicting key should 409');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraIdempotencyError);
      expect((err as InfraIdempotencyError).status).to.equal(409);
    }
  });

  it('does not lock twice when a payout Idempotency-Key is retried', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 100,
      idempotencyKey: `p1-pay-seed-${orgId}`,
    });
    const before = await getOrgBalance(orgId, 'test');
    const key = `p1-payout-${crypto.randomUUID()}`;
    const dest = `G${'C'.repeat(55)}`;
    const first = await createPayout({
      orgId,
      env: 'test',
      amount: 12.5,
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: dest,
      idempotencyKey: key,
    });
    const mid = await getOrgBalance(orgId, 'test');
    expect(mid.available).to.equal(before.available - 12.5);

    const second = await createPayout({
      orgId,
      env: 'test',
      amount: 12.5,
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: dest,
      idempotencyKey: key,
    });
    expect(second.id).to.equal(first.id);
    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(mid.available);
    expect(after.locked).to.equal(mid.locked);
  });

  it('refuses LIVE Yellow Card when organization KYC is missing', async () => {
    ycProto.isConfigured = () => true;
    try {
      await createCollection({
        orgId,
        env: 'live',
        amount: 1000,
        currency: 'NGN',
        country: 'NG',
      });
      expect.fail('LIVE collect should require KYC');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraRailError);
      expect((err as InfraRailError).status).to.equal(400);
      expect((err as InfraRailError).message).to.match(/BVN|KYC/i);
    }
  });
});
