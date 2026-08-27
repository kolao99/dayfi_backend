/**
 * Phase 3 infra recipients — org isolation, masking, send-by-recipient.
 *
 * Run: npm run test:infra-recipients
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
import {
  createRecipient,
  getRecipient,
  InfraRecipientError,
  listRecipients,
  maskDestination,
  resolveDestinationForPayout,
} from '../../src/modules/infra/infraRecipientService';
import { createPayout } from '../../src/modules/infra/infraMoneyService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `rcpt-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Recipient Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra recipients (Phase 3)', function () {
  this.timeout(30000);
  let orgA: string;
  let orgB: string;

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_recipients') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-recipients');
    }
    orgA = await createTestOrg('a');
    orgB = await createTestOrg('b');
  });

  after(async () => {
    if (orgA) await cleanupOrg(orgA);
    if (orgB) await cleanupOrg(orgB);
  });

  it('masks bank and crypto destinations for display', () => {
    const bank = maskDestination(
      'bank',
      {
        accountNumber: '0123454821',
        accountName: 'John Doe',
        bankCode: '058',
        bankName: 'GTBank',
      },
      'GTBank'
    );
    expect(bank.lastFour).to.equal('4821');
    expect(bank.displayHint).to.equal('GTBank ···· 4821');

    const cryptoDest = maskDestination('crypto', {
      walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF7F2A',
      asset: 'USDC',
      network: 'stellar',
    });
    expect(cryptoDest.lastFour).to.equal('7F2A');
    expect(cryptoDest.displayHint).to.include('USDC');
    expect(cryptoDest.displayHint).to.include('····7F2A');
  });

  it('creates recipient with destination; list never exposes secrets', async () => {
    const created = await createRecipient({
      orgId: orgA,
      environment: 'test',
      displayName: 'John Doe',
      country: 'NG',
      destination: {
        rail: 'bank',
        currency: 'NGN',
        country: 'NG',
        provider: 'GTBank',
        destinationData: {
          accountNumber: '0123454821',
          accountName: 'John Doe',
          bankCode: '058',
          bankName: 'GTBank',
        },
      },
    });

    expect(created.displayName).to.equal('John Doe');
    expect(created.destinations).to.have.length(1);
    const dest = created.destinations[0];
    expect(dest.displayHint).to.include('4821');
    expect(dest.lastFour).to.equal('4821');
    expect(dest).to.not.have.property('destinationData');
    expect(JSON.stringify(created)).to.not.include('0123454821');

    const listed = await listRecipients(orgA, 'test');
    const john = listed.find((r) => r.id === created.id);
    expect(john).to.exist;
    expect(JSON.stringify(john)).to.not.include('0123454821');
    expect(JSON.stringify(john)).to.not.include('destination_data');
  });

  it('enforces org isolation on get and resolve', async () => {
    const created = await createRecipient({
      orgId: orgA,
      environment: 'test',
      displayName: 'Org A Only',
      destination: {
        rail: 'mobile_money',
        country: 'GH',
        currency: 'GHS',
        provider: 'MTN',
        destinationData: {
          phone: '233241234567',
          accountName: 'Ama',
          networkId: 'mtn',
        },
      },
    });

    try {
      await getRecipient(orgB, created.id, 'test');
      expect.fail('should not read cross-org recipient');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraRecipientError);
      expect((err as InfraRecipientError).status).to.equal(404);
    }

    try {
      await resolveDestinationForPayout({
        orgId: orgB,
        environment: 'test',
        recipientId: created.id,
      });
      expect.fail('should not resolve cross-org');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraRecipientError);
      expect((err as InfraRecipientError).status).to.equal(404);
    }
  });

  it('send-by-recipient locks funds via Phase 2 lifecycle', async () => {
    await creditOrgWallet({
      orgId: orgA,
      environment: 'test',
      amount: 500,
      idempotencyKey: `seed-rcpt-${orgA}-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgA, 'test');

    const recipient = await createRecipient({
      orgId: orgA,
      environment: 'test',
      displayName: 'Payout Target',
      country: 'NG',
      destination: {
        rail: 'crypto',
        currency: 'USDC',
        provider: 'stellar',
        destinationData: {
          walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF7F2A',
          asset: 'USDC',
          network: 'stellar',
          accountName: 'Payout Target',
        },
      },
    });

    const payout = await createPayout({
      orgId: orgA,
      env: 'test',
      amount: 150,
      recipientId: recipient.id,
      destinationId: recipient.destinations[0].id,
    });

    expect(payout.fundsLocked).to.equal(true);
    expect(payout.usdcAmount).to.equal(150);

    const after = await getOrgBalance(orgA, 'test');
    expect(after.available).to.equal(before.available - 150);
    expect(after.locked).to.equal(before.locked + 150);

    const meta = await db.one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM infra_transactions WHERE id = $1`,
      [payout.id]
    );
    const saved = meta.metadata?.savedRecipient as Record<string, unknown> | undefined;
    expect(saved?.recipientId).to.equal(recipient.id);
    expect(saved?.destinationId).to.equal(recipient.destinations[0].id);
  });
});
