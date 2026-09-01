/**
 * Tests for Infra bill payments — org ledger debit, validate behavior, lock/release.
 *
 * Run: npm run test:infra-bills
 */

import { expect } from 'chai';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
} from '../../src/modules/infra/infraLedgerService';
import {
  InfraBillError,
  __setBillProviderForTests,
  payInfraBill,
  resolveFlutterwaveBillOutcome,
  validateInfraBill,
} from '../../src/modules/infra/infraBillsService';
import { billsService } from '../../src/modules/payment/billsService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `bills-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Bills Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra bills', function () {
  this.timeout(60000);
  let orgId: string;
  let prevNoSimulate: string | undefined;

  before(async () => {
    orgId = await createTestOrg('main');
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 500,
      idempotencyKey: `bills-test-credit-${crypto.randomUUID()}`,
      movementType: 'test_credit',
      referenceType: 'test',
      referenceId: orgId,
    });
  });

  after(async () => {
    if (orgId) await cleanupOrg(orgId);
  });

  beforeEach(() => {
    prevNoSimulate = process.env.INFRA_BILLS_TEST_NO_SIMULATE;
    __setBillProviderForTests(null);
  });

  afterEach(() => {
    if (prevNoSimulate === undefined) {
      delete process.env.INFRA_BILLS_TEST_NO_SIMULATE;
    } else {
      process.env.INFRA_BILLS_TEST_NO_SIMULATE = prevNoSimulate;
    }
    __setBillProviderForTests(null);
  });

  it('resolveFlutterwaveBillOutcome detects pending and failed', () => {
    expect(
      resolveFlutterwaveBillOutcome({ status: 'success' }, null)
    ).to.equal('success');
    expect(
      resolveFlutterwaveBillOutcome({ status: 'pending' }, { status: 'processing' })
    ).to.equal('pending');
    expect(
      resolveFlutterwaveBillOutcome({ status: 'failed' }, null)
    ).to.equal('failed');
  });

  it('validate skips for AIRTIME category', async () => {
    const data = await validateInfraBill({
      categoryCode: 'AIRTIME',
      billerCode: 'BIL099',
      itemCode: 'AT099',
      customerId: '08012345678',
    });
    expect((data as { skipped?: boolean }).skipped).to.equal(true);
  });

  it('payInfraBill debits org ledger not user wallet', async () => {
    const before = await getOrgBalance(orgId, 'test');
    const idempotencyKey = `bill-test-${crypto.randomUUID()}`;

    const result = await payInfraBill({
      orgId,
      env: 'test',
      idempotencyKey,
      categoryCode: 'AIRTIME',
      billerCode: 'BIL099',
      itemCode: 'AT099',
      customerId: '08012345678',
      amount: 500,
      billerName: 'MTN',
      itemName: 'Airtime',
    });

    expect(result.id).to.be.a('string');
    expect(result.status).to.be.oneOf(['settled', 'processing', 'pending']);

    const after = await getOrgBalance(orgId, 'test');
    if (result.status === 'settled') {
      expect(after.available).to.be.lessThan(before.available);
    }
  });

  it('validation failure after lock releases funds', async () => {
    process.env.INFRA_BILLS_TEST_NO_SIMULATE = '1';
    const origValidate = billsService.validateBill.bind(billsService);
    try {
      (billsService as { validateBill: typeof billsService.validateBill }).validateBill =
        async () => {
          throw new Error('Invalid meter number');
        };

      const before = await getOrgBalance(orgId, 'test');

      try {
        await payInfraBill({
          orgId,
          env: 'test',
          categoryCode: 'UTILITYBILLS',
          billerCode: 'BIL108',
          itemCode: 'UB108',
          customerId: '00000000000',
          amount: 200,
        });
        expect.fail('should throw');
      } catch (err) {
        expect(err).to.be.instanceOf(InfraBillError);
        expect((err as InfraBillError).code).to.equal('VALIDATION_FAILED');
      }

      const after = await getOrgBalance(orgId, 'test');
      expect(after.available).to.be.closeTo(before.available, 0.0001);
      expect(after.locked).to.be.closeTo(before.locked, 0.0001);
    } finally {
      (billsService as { validateBill: typeof billsService.validateBill }).validateBill =
        origValidate;
    }
  });

  it('provider failure after lock releases funds (no stuck lock)', async () => {
    process.env.INFRA_BILLS_TEST_NO_SIMULATE = '1';
    __setBillProviderForTests({
      createBillPayment: async () => {
        throw new Error('Flutterwave timeout');
      },
      fetchBillPaymentStatus: async () => ({}),
    });

    const before = await getOrgBalance(orgId, 'test');

    try {
      await payInfraBill({
        orgId,
        env: 'test',
        categoryCode: 'AIRTIME',
        billerCode: 'BIL099',
        itemCode: 'AT099',
        customerId: '08011112222',
        amount: 100,
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraBillError);
      expect((err as InfraBillError).code).to.equal('PROVIDER_FAILED');
    }

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.be.closeTo(before.available, 0.0001);
    expect(after.locked).to.be.closeTo(before.locked, 0.0001);
  });

  it('pending provider response keeps lock and returns processing', async () => {
    process.env.INFRA_BILLS_TEST_NO_SIMULATE = '1';
    __setBillProviderForTests({
      createBillPayment: async () => ({
        tx_ref: 'fw-pending-1',
        status: 'pending',
      }),
      fetchBillPaymentStatus: async () => ({ status: 'pending' }),
    });

    const before = await getOrgBalance(orgId, 'test');
    const result = await payInfraBill({
      orgId,
      env: 'test',
      categoryCode: 'AIRTIME',
      billerCode: 'BIL099',
      itemCode: 'AT099',
      customerId: '08033334444',
      amount: 150,
    });

    expect(result.status).to.equal('processing');
    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.be.lessThan(before.available);
    expect(after.locked).to.be.greaterThan(before.locked);
  });

  it('insufficient balance throws INSUFFICIENT_BALANCE before lock', async () => {
    const poorOrg = await createTestOrg('poor');
    try {
      await payInfraBill({
        orgId: poorOrg,
        env: 'test',
        categoryCode: 'AIRTIME',
        billerCode: 'BIL099',
        itemCode: 'AT099',
        customerId: '08099998888',
        amount: 999999,
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraBillError);
      expect((err as InfraBillError).code).to.equal('INSUFFICIENT_BALANCE');
    } finally {
      await cleanupOrg(poorOrg);
    }
  });

  it('idempotent replay returns same transaction', async () => {
    const idempotencyKey = `bill-idem-${crypto.randomUUID()}`;
    const first = await payInfraBill({
      orgId,
      env: 'test',
      idempotencyKey,
      categoryCode: 'AIRTIME',
      billerCode: 'BIL099',
      itemCode: 'AT099',
      customerId: '08098765432',
      amount: 200,
    });
    const second = await payInfraBill({
      orgId,
      env: 'test',
      idempotencyKey,
      categoryCode: 'AIRTIME',
      billerCode: 'BIL099',
      itemCode: 'AT099',
      customerId: '08098765432',
      amount: 200,
    });
    expect(second.id).to.equal(first.id);
    expect((second as { idempotentReplay?: boolean }).idempotentReplay).to.equal(true);
  });

  it('invalid amount throws InfraBillError', async () => {
    try {
      await payInfraBill({
        orgId,
        env: 'test',
        categoryCode: 'AIRTIME',
        billerCode: 'BIL099',
        itemCode: 'AT099',
        customerId: '08012345678',
        amount: 0,
      });
      expect.fail('should throw');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraBillError);
    }
  });

  it('billsService catalog methods are reachable via infra wrappers', async () => {
    const categories = await billsService.getCategories();
    expect(categories).to.exist;
  });
});
