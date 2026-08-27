/**
 * Increment E — Dayfi → Dayfi internal transfers (ledger-only).
 *
 * Run: npm run test:infra-internal-transfers
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
  createInternalTransfer,
  InfraTransferError,
} from '../../src/modules/infra/infraInternalTransferService';
import { runReconciliation } from '../../src/modules/infra/infraReconciliationService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `xfer-e-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Transfer E Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

async function seed(orgId: string, amount: number): Promise<void> {
  await creditOrgWallet({
    orgId,
    environment: 'test',
    amount,
    idempotencyKey: `e-seed-${orgId}-${crypto.randomUUID()}`,
  });
}

describe('infra internal transfers (Increment E)', function () {
  this.timeout(60000);
  let aliceId: string;
  let bobId: string;

  before(async () => {
    process.env.DAYFI_INFRA_INTERNAL_TRANSFER_FEE = 'off';
    process.env.DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE = 'INTERNAL_LEDGER';
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_internal_transfers') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-internal-transfers');
    }
    aliceId = await createTestOrg('alice');
    bobId = await createTestOrg('bob');
  });

  after(async () => {
    if (aliceId) await cleanupOrg(aliceId);
    if (bobId) await cleanupOrg(bobId);
  });

  it('moves $30 Alice → Bob atomically; total liability unchanged; no Stellar', async () => {
    await seed(aliceId, 100);
    await seed(bobId, 20);
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');
    const totalBefore = aliceBefore.available + bobBefore.available;

    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: 30,
      recipientOrgId: bobId,
      idempotencyKey: `e-happy-${crypto.randomUUID()}`,
    });

    expect(transfer.status).to.equal('completed');
    expect(transfer.settlementMode).to.equal('INTERNAL_LEDGER');
    expect(transfer.stellarTouched).to.equal(false);
    expect(transfer.settlement).to.equal(null);
    expect(transfer.provider).to.equal(null);
    expect(transfer.transferGroupId).to.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(transfer.senderTransactionId).to.be.a('string');
    expect(transfer.recipientTransactionId).to.be.a('string');
    expect(transfer.senderMovementId).to.be.a('string');
    expect(transfer.recipientMovementId).to.be.a('string');

    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available - 30);
    expect(bobAfter.available).to.equal(bobBefore.available + 30);
    expect(aliceAfter.available + bobAfter.available).to.equal(totalBefore);
    expect(aliceAfter.locked).to.equal(aliceBefore.locked);
    expect(bobAfter.locked).to.equal(bobBefore.locked);

    const movements = await db.manyOrNone<{
      org_id: string;
      direction: string;
      amount: string;
      movement_type: string;
      reference: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT org_id::text AS org_id, direction, amount::text, movement_type,
              reference, metadata
       FROM infra_ledger_movements
       WHERE reference = $1
       ORDER BY direction`,
      [transfer.transferGroupId]
    );
    expect(movements).to.have.length(2);
    expect(movements.map((m) => m.metadata.transferGroupId)).to.deep.equal([
      transfer.transferGroupId,
      transfer.transferGroupId,
    ]);
    const debit = movements.find((m) => m.direction === 'debit');
    const credit = movements.find((m) => m.direction === 'credit');
    expect(debit?.org_id).to.equal(aliceId);
    expect(credit?.org_id).to.equal(bobId);
    expect(Number(debit?.amount)).to.equal(30);
    expect(Number(credit?.amount)).to.equal(30);
    expect(debit?.movement_type).to.equal('internal_transfer_debit');
    expect(credit?.movement_type).to.equal('internal_transfer_credit');

    const settlements = await db.manyOrNone(
      `SELECT id FROM infra_settlements
       WHERE payout_transaction_id IN ($1, $2)
          OR collection_transaction_id IN ($1, $2)`,
      [transfer.senderTransactionId, transfer.recipientTransactionId]
    );
    expect(settlements).to.have.length(0);

    const txs = await db.many<{ metadata: Record<string, unknown>; status: string }>(
      `SELECT metadata, status FROM infra_transactions
       WHERE id IN ($1, $2)`,
      [transfer.senderTransactionId, transfer.recipientTransactionId]
    );
    expect(txs).to.have.length(2);
    for (const tx of txs) {
      expect(tx.status).to.equal('completed');
      expect(tx.metadata.stellarTouched).to.equal(false);
      expect(tx.metadata.settlementRail).to.equal('NONE');
      expect(tx.metadata.transferGroupId).to.equal(transfer.transferGroupId);
    }
  });

  it('does not transfer a second $30 on idempotency replay', async () => {
    await seed(aliceId, 50);
    await seed(bobId, 10);
    const key = `e-replay-${crypto.randomUUID()}`;
    const first = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: 30,
      recipientOrgId: bobId,
      idempotencyKey: key,
    });
    const aliceMid = await getOrgBalance(aliceId, 'test');
    const bobMid = await getOrgBalance(bobId, 'test');
    const second = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: 30,
      recipientOrgId: bobId,
      idempotencyKey: key,
    });
    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(second.duplicate).to.equal(true);
    expect(second.transferGroupId).to.equal(first.transferGroupId);
    expect(second.senderTransactionId).to.equal(first.senderTransactionId);
    expect(aliceAfter.available).to.equal(aliceMid.available);
    expect(bobAfter.available).to.equal(bobMid.available);

    const debitCount = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_ledger_movements
       WHERE reference = $1 AND movement_type = 'internal_transfer_debit'`,
      [first.transferGroupId]
    );
    expect(Number(debitCount.n)).to.equal(1);
  });

  it('rejects reused idempotency key with a different payload', async () => {
    await seed(aliceId, 40);
    const key = `e-conflict-${crypto.randomUUID()}`;
    await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: 10,
      recipientOrgId: bobId,
      idempotencyKey: key,
    });
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: 15,
        recipientOrgId: bobId,
        idempotencyKey: key,
      });
    } catch (err) {
      expect(err).to.be.instanceOf(InfraTransferError);
      code = (err as InfraTransferError).code;
    }
    expect(code).to.equal('IDEMPOTENCY_CONFLICT');
  });

  it('rejects insufficient available balance without moving funds', async () => {
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: aliceBefore.available + 1000,
        recipientOrgId: bobId,
        idempotencyKey: `e-insuf-${crypto.randomUUID()}`,
      });
    } catch (err) {
      expect(err).to.be.instanceOf(InfraLedgerError);
      code = (err as InfraLedgerError).code;
    }
    expect(code).to.equal('INSUFFICIENT_BALANCE');
    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    expect(bobAfter.available).to.equal(bobBefore.available);
  });

  it('rejects unknown, inactive, self, and cross-environment recipients', async () => {
    await seed(aliceId, 25);
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');

    let unknown = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: 5,
        recipientOrgId: crypto.randomUUID(),
      });
    } catch (err) {
      unknown = (err as InfraTransferError).code;
    }
    expect(unknown).to.equal('UNKNOWN_RECIPIENT');

    let self = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: 5,
        recipientOrgId: aliceId,
      });
    } catch (err) {
      self = (err as InfraTransferError).code;
    }
    expect(self).to.equal('SELF_TRANSFER');

    let cross = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: 5,
        recipientOrgId: bobId,
        recipientEnvironment: 'live',
      });
    } catch (err) {
      cross = (err as InfraTransferError).code;
    }
    expect(cross).to.equal('CROSS_ENVIRONMENT');

    await db.none(
      `UPDATE infra_wallet_accounts SET status = 'frozen'
       WHERE org_id = $1 AND environment = 'test'`,
      [bobId]
    );
    let inactive = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: 5,
        recipientOrgId: bobId,
        idempotencyKey: `e-frozen-${crypto.randomUUID()}`,
      });
    } catch (err) {
      inactive = (err as InfraLedgerError).code;
    }
    await db.none(
      `UPDATE infra_wallet_accounts SET status = 'active'
       WHERE org_id = $1 AND environment = 'test'`,
      [bobId]
    );
    expect(inactive).to.equal('RECIPIENT_INACTIVE');

    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    expect(bobAfter.available).to.equal(bobBefore.available);
  });

  it('rolls back Alice debit if Bob credit fails (atomicity)', async () => {
    await seed(aliceId, 30);
    await seed(bobId, 5);
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');

    await db.none(`
      CREATE TABLE IF NOT EXISTS infra_e_test_flags (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `);
    await db.none(
      `INSERT INTO infra_e_test_flags (k, v) VALUES ('fail_internal_credit', '1')
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`
    );
    await db.none(`
      CREATE OR REPLACE FUNCTION infra_e_test_fail_credit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.movement_type = 'internal_transfer_credit'
           AND EXISTS (
             SELECT 1 FROM infra_e_test_flags
             WHERE k = 'fail_internal_credit' AND v = '1'
           ) THEN
          RAISE EXCEPTION 'forced credit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.none(`
      DROP TRIGGER IF EXISTS infra_e_test_fail_credit_trg ON infra_ledger_movements
    `);
    await db.none(`
      CREATE TRIGGER infra_e_test_fail_credit_trg
      BEFORE INSERT ON infra_ledger_movements
      FOR EACH ROW EXECUTE FUNCTION infra_e_test_fail_credit()
    `);

    let failed = false;
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: 12,
        recipientOrgId: bobId,
        idempotencyKey: `e-atomic-${crypto.randomUUID()}`,
      });
    } catch {
      failed = true;
    } finally {
      await db.none(
        `UPDATE infra_e_test_flags SET v = '0' WHERE k = 'fail_internal_credit'`
      );
      await db.none(
        `DROP TRIGGER IF EXISTS infra_e_test_fail_credit_trg ON infra_ledger_movements`
      );
      await db.none(`DROP FUNCTION IF EXISTS infra_e_test_fail_credit()`);
      await db.none(`DROP TABLE IF EXISTS infra_e_test_flags`);
    }

    expect(failed).to.equal(true);
    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    expect(bobAfter.available).to.equal(bobBefore.available);
    expect(aliceAfter.available + bobAfter.available).to.equal(
      aliceBefore.available + bobBefore.available
    );

    const leftover = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_internal_transfers
       WHERE sender_org_id = $1 AND amount = 12 AND created_at > NOW() - INTERVAL '2 minutes'`,
      [aliceId]
    );
    expect(Number(leftover.n)).to.equal(0);
  });

  it('reconciles both legs as RECONCILED with settlement not applicable', async () => {
    await seed(aliceId, 30);
    await seed(bobId, 10);
    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: 8,
      recipientOrgId: bobId,
      idempotencyKey: `e-recon-${crypto.randomUUID()}`,
    });

    const senderRecon = await runReconciliation({
      orgId: aliceId,
      environment: 'test',
      transactionIds: [transfer.senderTransactionId!],
      idempotencyKey: `recon-e-out-${transfer.id}`,
      triggerSource: 'test',
    });
    const recipientRecon = await runReconciliation({
      orgId: bobId,
      environment: 'test',
      transactionIds: [transfer.recipientTransactionId!],
      idempotencyKey: `recon-e-in-${transfer.id}`,
      triggerSource: 'test',
    });

    expect(senderRecon.items[0].status).to.equal('reconciled');
    expect(senderRecon.items[0].resultCode).to.equal('RECONCILED');
    expect(senderRecon.items[0].direction).to.equal('internal_transfer');
    expect(senderRecon.items[0].settlement.required).to.equal(false);
    expect(senderRecon.items[0].provider.present).to.equal(false);

    expect(recipientRecon.items[0].status).to.equal('reconciled');
    expect(recipientRecon.items[0].resultCode).to.equal('RECONCILED');
    expect(recipientRecon.items[0].direction).to.equal('internal_transfer');
  });
});
