/**
 * Increment H — Fiat offramp: Alice Stellar USDC → treasury → Provider.
 *
 * Run: npm run test:infra-fiat-offramp
 */

import { expect } from 'chai';
import { describe, it, before, after, beforeEach } from 'mocha';
import crypto from 'crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../src/config/database';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
} from '../../src/modules/infra/infraLedgerService';
import { createPayout } from '../../src/modules/infra/infraMoneyService';
import { provisionOrgStellarAccount } from '../../src/modules/infra/infraStellarAccountService';
import {
  settleFiatOfframp,
  retryFiatOfframpProvider,
  getInfraFiatOfframpMode,
} from '../../src/modules/infra/infraFiatWithdrawalService';
import { runReconciliation } from '../../src/modules/infra/infraReconciliationService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `offramp-h-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Offramp H Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra fiat offramp (Increment H)', function () {
  this.timeout(90000);
  let orgId: string;
  const feePayer = StellarSdk.Keypair.random();
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const key of [
      'DAYFI_INFRA_FIAT_OFFRAMP_MODE',
      'DAYFI_STELLAR_SETTLEMENT_MODE',
      'DAYFI_INFRA_STELLAR_PROVISION_MODE',
      'DAYFI_STELLAR_FEE_PAYER_MODE',
      'DAYFI_STELLAR_FEE_PAYER_ENABLED',
      'DAYFI_STELLAR_FEE_PAYER_MIN_XLM',
      'DAYFI_STELLAR_FEE_PAYER_MOCK_XLM',
      'DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY',
      'DAYFI_STELLAR_FEE_PAYER_SECRET',
      'DAYFI_STELLAR_SETTLEMENT_SECRET',
      'DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
    process.env.DAYFI_STELLAR_FEE_PAYER_MIN_XLM = '5';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = feePayer.publicKey();
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = feePayer.secret();
    // Dedicated mock treasury (distinct from Alice).
    process.env.DAYFI_STELLAR_SETTLEMENT_SECRET = StellarSdk.Keypair.random().secret();
    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;

    orgId = await createTestOrg('main');
    await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });
  });

  beforeEach(() => {
    process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (orgId) await cleanupOrg(orgId);
  });

  it('defaults offramp mode to off outside this suite', () => {
    process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = '';
    expect(getInfraFiatOfframpMode()).to.equal('off');
    process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock';
  });

  it('locks → Alice→treasury Stellar → Provider → completed; RECONCILED', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 100,
      idempotencyKey: `h-seed-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgId, 'test');

    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 30,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice Test',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `h-happy-${crypto.randomUUID()}`,
    });
    expect(payout.fundsLocked).to.equal(true);
    expect((payout as { offRamp?: boolean }).offRamp).to.equal(true);
    expect((payout as { offRampPhase?: string }).offRampPhase).to.equal('locked');

    const locked = await getOrgBalance(orgId, 'test');
    expect(locked.available).to.equal(before.available - 30);
    expect(locked.locked).to.equal(before.locked + 30);

    const result = await settleFiatOfframp({
      orgId,
      payoutTransactionId: payout.id,
    });
    expect(result.status).to.equal('completed');
    expect(result.stellar?.status).to.equal('confirmed');
    expect(result.provider?.status).to.equal('confirmed');
    expect(result.stellar?.externalReference).to.match(/^[a-f0-9]{64}$/);
    expect(result.provider?.providerReference || result.provider?.externalReference).to.be.a(
      'string'
    );

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available - 30);
    expect(after.locked).to.equal(before.locked);

    const recon = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [payout.id],
      idempotencyKey: `recon-h-${payout.id}`,
      triggerSource: 'test',
    });
    expect(recon.items[0].resultCode).to.equal('RECONCILED');
    expect(recon.items[0].settlement.rail).to.equal('STELLAR+PROVIDER');
  });

  it('does not double-settle on replay', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 50,
      idempotencyKey: `h-replay-seed-${crypto.randomUUID()}`,
    });
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 10,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice Test',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `h-replay-${crypto.randomUUID()}`,
    });
    const first = await settleFiatOfframp({
      orgId,
      payoutTransactionId: payout.id,
    });
    const mid = await getOrgBalance(orgId, 'test');
    const second = await settleFiatOfframp({
      orgId,
      payoutTransactionId: payout.id,
    });
    expect(second.duplicate === true || second.status === 'completed').to.equal(true);
    expect(second.stellar?.externalReference).to.equal(first.stellar?.externalReference);
    expect((await getOrgBalance(orgId, 'test')).available).to.equal(mid.available);

    const stellarCount = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE payout_transaction_id = $1 AND rail = 'STELLAR' AND status = 'confirmed'`,
      [payout.id]
    );
    expect(Number(stellarCount.n)).to.equal(1);
  });

  it('Provider failure after Stellar keeps treasury funds; retry completes', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 80,
      idempotencyKey: `h-fail-seed-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgId, 'test');
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 20,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice Test',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `h-fail-${crypto.randomUUID()}`,
    });

    process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL = '1';
    const failed = await settleFiatOfframp({
      orgId,
      payoutTransactionId: payout.id,
    });
    expect(failed.status).to.equal('provider_retry_required');
    expect(failed.stellar?.status).to.equal('confirmed');
    expect(failed.providerRetryRequired).to.equal(true);

    const mid = await getOrgBalance(orgId, 'test');
    // Still locked — not released to Alice.
    expect(mid.available).to.equal(before.available - 20);
    expect(mid.locked).to.be.at.least(20);

    const reconFail = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [payout.id],
      idempotencyKey: `recon-h-fail-${payout.id}`,
      triggerSource: 'test',
    });
    expect(reconFail.items[0].resultCode).to.not.equal('RECONCILED');

    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;
    const retried = await retryFiatOfframpProvider({
      orgId,
      payoutTransactionId: payout.id,
    });
    expect(retried.status).to.equal('completed');
    expect(retried.provider?.status).to.equal('confirmed');

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available - 20);
    expect(after.locked).to.equal(before.locked);

    const stellarCount = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE payout_transaction_id = $1 AND rail = 'STELLAR' AND status = 'confirmed'`,
      [payout.id]
    );
    expect(Number(stellarCount.n)).to.equal(1);
  });

  it('Stellar submit failure unlocks Alice and skips Provider', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 40,
      idempotencyKey: `h-stellar-fail-seed-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgId, 'test');
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 15,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice Test',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `h-stellar-fail-${crypto.randomUUID()}`,
    });

    process.env.DAYFI_INFRA_ONCHAIN_FORCE_FAIL = '1';
    let code = '';
    try {
      await settleFiatOfframp({
        orgId,
        payoutTransactionId: payout.id,
      });
    } catch (err) {
      code = (err as { code?: string }).code || '';
    }
    delete process.env.DAYFI_INFRA_ONCHAIN_FORCE_FAIL;
    expect(code).to.equal('STELLAR_SUBMIT_FAILED');

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available);
    expect(after.locked).to.equal(before.locked);

    const providerCount = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE payout_transaction_id = $1 AND rail = 'YELLOW_CARD'`,
      [payout.id]
    );
    expect(Number(providerCount.n)).to.equal(0);
  });
});
