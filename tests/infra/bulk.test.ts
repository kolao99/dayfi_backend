/**
 * Phase 4 infra bulk — preflight, confirm via Phase 2 children, CSV, no parent ledger.
 *
 * Run: npm run test:infra-bulk
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
} from '../../src/modules/infra/infraLedgerService';
import { createRecipient } from '../../src/modules/infra/infraRecipientService';
import {
  confirmBulkBatch,
  createBulkBatch,
  importBulkCsv,
  InfraBulkError,
  parseBulkCsv,
  runPreflight,
} from '../../src/modules/infra/infraBulkService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `bulk-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Bulk Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

async function makeCryptoRecipient(orgId: string, name: string, addrSuffix: string) {
  return createRecipient({
    orgId,
    environment: 'test',
    displayName: name,
    destination: {
      rail: 'crypto',
      currency: 'USDC',
      provider: 'stellar',
      destinationData: {
        walletAddress: `GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD${addrSuffix}`,
        asset: 'USDC',
        network: 'stellar',
      },
    },
  });
}

describe('infra bulk (Phase 4)', function () {
  this.timeout(60000);
  let orgId: string;

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_bulk_batches') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-bulk');
    }
    orgId = await createTestOrg('main');
  });

  after(async () => {
    if (orgId) await cleanupOrg(orgId);
  });

  it('parses CSV into recipient rows', () => {
    const rows = parseBulkCsv(
      'recipient_id,amount,currency\nr1,10,USDC\nr2,20,USDC\n'
    );
    expect(rows).to.have.length(2);
    expect(rows[0].recipient_id).to.equal('r1');
    expect(rows[1].amount).to.equal('20');
  });

  it('preflight fails without sufficient balance; succeeds after credit', async () => {
    const r1 = await makeCryptoRecipient(orgId, 'Bulk A', '1111');
    const r2 = await makeCryptoRecipient(orgId, 'Bulk B', '2222');

    const draft = await createBulkBatch({
      orgId,
      environment: 'test',
      label: 'Preflight batch',
      items: [
        { recipientId: r1.id, amount: 100, currency: 'USDC' },
        { recipientId: r2.id, amount: 50, currency: 'USDC' },
      ],
      runPreflight: true,
    });

    expect(draft.status).to.equal('draft');
    expect(draft.preflight?.ok).to.equal(false);
    const balanceCheck = (draft.preflight?.checks as any[])?.find(
      (c) => c.code === 'SUFFICIENT_BALANCE'
    );
    expect(balanceCheck?.ok).to.equal(false);

    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 200,
      idempotencyKey: `bulk-seed-${orgId}-${crypto.randomUUID()}`,
    });

    const ready = await runPreflight(orgId, draft.id);
    expect(ready.status).to.equal('ready');
    expect(ready.totalUsdc).to.equal(150);
    expect(ready.preflight?.ok).to.equal(true);
  });

  it('confirm locks via child payouts only; parent never writes ledger', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 500,
      idempotencyKey: `bulk-seed2-${orgId}-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgId, 'test');

    const a = await makeCryptoRecipient(orgId, 'Confirm A', '3333');
    const b = await makeCryptoRecipient(orgId, 'Confirm B', '4444');

    const batch = await createBulkBatch({
      orgId,
      environment: 'test',
      items: [
        { recipientId: a.id, amount: 40, currency: 'USDC' },
        { recipientId: b.id, amount: 60, currency: 'USDC' },
      ],
    });
    expect(batch.status).to.equal('ready');

    const confirmed = await confirmBulkBatch(orgId, batch.id, {
      autoSimulateTest: true,
    });

    expect(confirmed.status).to.equal('completed');
    expect(confirmed.completedUsdc).to.equal(100);
    expect(confirmed.completedCount).to.equal(2);
    expect(confirmed.failedCount).to.equal(0);

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available - 100);

    // Parent must not invent its own ledger reference_type
    const parentLedger = await db.oneOrNone(
      `SELECT id FROM infra_ledger_movements
       WHERE org_id = $1 AND reference_type = 'bulk_batch'
       LIMIT 1`,
      [orgId]
    );
    expect(parentLedger).to.equal(null);

    const childLinks = confirmed.items.filter((i: any) => i.payoutTransactionId);
    expect(childLinks).to.have.length(2);
  });

  it('CSV import creates a batch and runs preflight', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 100,
      idempotencyKey: `bulk-csv-${orgId}-${crypto.randomUUID()}`,
    });
    const r = await makeCryptoRecipient(orgId, 'CSV Target', '5555');

    const csv = `recipient_id,amount,currency\n${r.id},25,USDC\n`;
    const batch = await importBulkCsv({
      orgId,
      environment: 'test',
      csvText: csv,
      label: 'CSV contractors',
    });

    expect(batch.source).to.equal('csv');
    expect(batch.itemCount).to.equal(1);
    expect(batch.status).to.equal('ready');
    expect(batch.totalUsdc).to.equal(25);
  });

  it('rejects confirm when not ready', async () => {
    // Missing destination → preflight leaves batch in draft
    const orphan = await db.one<{ id: string }>(
      `INSERT INTO infra_recipients (org_id, environment, display_name, status)
       VALUES ($1, 'test', 'No Destination', 'active')
       RETURNING id::text AS id`,
      [orgId]
    );

    const batch = await createBulkBatch({
      orgId,
      environment: 'test',
      items: [{ recipientId: orphan.id, amount: 1, currency: 'USDC' }],
      runPreflight: true,
    });
    expect(batch.status).to.equal('draft');
    try {
      await confirmBulkBatch(orgId, batch.id);
      expect.fail('should reject');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraBulkError);
      expect((err as InfraBulkError).code).to.equal('NOT_READY');
    }
  });
});
