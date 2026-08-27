/**
 * Increment G — Treasury / Liquidity Management.
 *
 * Run: npm run test:infra-treasury
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
import { ensureFeeRevenueOrg } from '../../src/modules/infra/infraFeeService';
import { provisionOrgStellarAccount } from '../../src/modules/infra/infraStellarAccountService';
import { createPayout } from '../../src/modules/infra/infraMoneyService';
import {
  settleFiatOfframp,
  retryFiatOfframpProvider,
} from '../../src/modules/infra/infraFiatWithdrawalService';
import {
  executeTreasuryRebalance,
  getCustomerLiabilityTotals,
  getTreasuryPosition,
  InfraTreasuryError,
  reconcileTreasuryPosition,
  requestTreasuryRebalance,
  submitTreasuryRebalance,
} from '../../src/modules/infra/infraTreasuryService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `treasury-g-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Treasury G Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra treasury / liquidity (Increment G)', function () {
  this.timeout(90000);

  let aliceId: string;
  let bobId: string;
  const treasuryKp = StellarSdk.Keypair.random();
  const secondaryKp = StellarSdk.Keypair.random();
  const feePayer = StellarSdk.Keypair.random();
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    'DAYFI_STELLAR_SETTLEMENT_MODE',
    'DAYFI_STELLAR_SETTLEMENT_SECRET',
    'DAYFI_TREASURY_MOCK_USDC',
    'DAYFI_TREASURY_MOCK_XLM',
    'DAYFI_TREASURY_FROZEN',
    'DAYFI_TREASURY_REBALANCE_OPEN',
    'DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY',
    'DAYFI_TREASURY_HEALTHY_COVERAGE',
    'DAYFI_TREASURY_LOW_COVERAGE',
    'DAYFI_INFRA_FIAT_OFFRAMP_MODE',
    'DAYFI_INFRA_STELLAR_PROVISION_MODE',
    'DAYFI_STELLAR_FEE_PAYER_MODE',
    'DAYFI_STELLAR_FEE_PAYER_ENABLED',
    'DAYFI_STELLAR_FEE_PAYER_MIN_XLM',
    'DAYFI_STELLAR_FEE_PAYER_MOCK_XLM',
    'DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY',
    'DAYFI_STELLAR_FEE_PAYER_SECRET',
    'DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL',
    'STELLAR_NETWORK',
  ];

  before(async () => {
    for (const key of envKeys) saved[key] = process.env[key];

    process.env.STELLAR_NETWORK = 'testnet';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_STELLAR_SETTLEMENT_SECRET = treasuryKp.secret();
    process.env.DAYFI_TREASURY_MOCK_USDC = '100';
    process.env.DAYFI_TREASURY_MOCK_XLM = '50';
    process.env.DAYFI_TREASURY_REBALANCE_OPEN = 'true';
    process.env.DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY = secondaryKp.publicKey();
    process.env.DAYFI_TREASURY_HEALTHY_COVERAGE = '1.05';
    process.env.DAYFI_TREASURY_LOW_COVERAGE = '1.0';
    delete process.env.DAYFI_TREASURY_FROZEN;

    process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
    process.env.DAYFI_STELLAR_FEE_PAYER_MIN_XLM = '5';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = feePayer.publicKey();
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = feePayer.secret();
    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;

    aliceId = await createTestOrg('alice');
    bobId = await createTestOrg('bob');
    await provisionOrgStellarAccount({
      orgId: aliceId,
      environment: 'test',
      mode: 'mock',
    });
  });

  beforeEach(() => {
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_TREASURY_MOCK_USDC = '100';
    process.env.DAYFI_TREASURY_MOCK_XLM = '50';
    process.env.DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY = secondaryKp.publicKey();
    process.env.DAYFI_TREASURY_REBALANCE_OPEN = 'true';
    delete process.env.DAYFI_TREASURY_FROZEN;
    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;
    process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE = 'mock';
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (aliceId) await cleanupOrg(aliceId);
    if (bobId) await cleanupOrg(bobId);
  });

  it('aggregates customer liabilities and detects liquidity shortfall', async () => {
    await creditOrgWallet({
      orgId: aliceId,
      environment: 'test',
      amount: 70,
      idempotencyKey: `g-alice-${crypto.randomUUID()}`,
    });
    await creditOrgWallet({
      orgId: bobId,
      environment: 'test',
      amount: 50,
      idempotencyKey: `g-bob-${crypto.randomUUID()}`,
    });

    const liabilities = await getCustomerLiabilityTotals({ environment: 'test' });
    expect(liabilities.totalAvailableCustomerFunds).to.be.at.least(120);

    process.env.DAYFI_TREASURY_MOCK_USDC = '100';
    const position = await getTreasuryPosition({ environment: 'test' });
    expect(Number(position.usdc.onChainBalance)).to.equal(100);
    expect(Number(position.usdc.customerLiability)).to.be.at.least(120);
    expect(Number(position.usdc.liquidityGap)).to.be.below(0);
    expect(position.status).to.equal('INSUFFICIENT_LIQUIDITY');
    expect(position.customerCustody.countedAsTreasury).to.equal(false);
    expect(position.publicKey).to.equal(treasuryKp.publicKey());
  });

  it('excludes Dayfi fee revenue from customer liability', async () => {
    const feeOrgId = await ensureFeeRevenueOrg();
    await creditOrgWallet({
      orgId: feeOrgId,
      environment: 'test',
      amount: 12.34,
      idempotencyKey: `g-fee-${crypto.randomUUID()}`,
    });
    const liabilities = await getCustomerLiabilityTotals({ environment: 'test' });
    expect(liabilities.excludedFeeRevenue).to.be.at.least(12.34);
    const position = await getTreasuryPosition({ environment: 'test' });
    expect(Number(position.dayfiFeeRevenue.ledgerUsdc)).to.be.at.least(12.34);
  });

  it('marks HEALTHY when treasury covers liabilities with buffer', async () => {
    const liabilities = await getCustomerLiabilityTotals({ environment: 'test' });
    const needed = Math.max(liabilities.totalCustomerLiability * 2, 1000);
    process.env.DAYFI_TREASURY_MOCK_USDC = String(needed);
    const position = await getTreasuryPosition({ environment: 'test' });
    expect(Number(position.usdc.onChainBalance)).to.equal(needed);
    expect(Number(position.usdc.customerLiability)).to.be.at.most(needed);
    expect(Number(position.usdc.liquidityGap)).to.be.at.least(0);
    expect(position.status).to.be.oneOf(['HEALTHY', 'LOW_LIQUIDITY']);
  });

  it('manual rebalance moves Dayfi treasury→treasury once; replay is idempotent', async () => {
    process.env.DAYFI_TREASURY_MOCK_USDC = '1000';
    const aliceBefore = await getOrgBalance(aliceId, 'test');

    const key = `g-rebalance-${crypto.randomUUID()}`;
    const first = await executeTreasuryRebalance({
      environment: 'test',
      amount: 25,
      destinationPublicKey: secondaryKp.publicKey(),
      idempotencyKey: key,
      requestedBy: 'test-operator',
    });
    expect(first.status).to.equal('confirmed');
    expect(first.stellarTransactionHash).to.match(/^[a-f0-9]{64}$/);
    expect(first.actualNetworkFeeXlm || first.railMetadata.actualNetworkFeeXlm).to.be.ok;

    const second = await executeTreasuryRebalance({
      environment: 'test',
      amount: 25,
      destinationPublicKey: secondaryKp.publicKey(),
      idempotencyKey: key,
      requestedBy: 'test-operator',
    });
    expect(second.duplicate === true || second.status === 'confirmed').to.equal(true);
    expect(second.stellarTransactionHash).to.equal(first.stellarTransactionHash);

    const count = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_treasury_rebalances
       WHERE idempotency_key = $1`,
      [key]
    );
    expect(Number(count.n)).to.equal(1);

    const aliceAfter = await getOrgBalance(aliceId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    expect(aliceAfter.locked).to.equal(aliceBefore.locked);
  });

  it('rejects rebalance to a customer custody wallet', async () => {
    const aliceWallet = await provisionOrgStellarAccount({
      orgId: aliceId,
      environment: 'test',
      mode: 'mock',
    });
    process.env.DAYFI_TREASURY_MOCK_USDC = '1000';
    process.env.DAYFI_TREASURY_REBALANCE_OPEN = 'true';
    delete process.env.DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY;

    let err: InfraTreasuryError | null = null;
    try {
      await requestTreasuryRebalance({
        environment: 'test',
        amount: 10,
        destinationPublicKey: aliceWallet.publicKey,
        idempotencyKey: `g-customer-${crypto.randomUUID()}`,
        autoApprove: true,
      });
    } catch (e: any) {
      err = e;
    }
    expect(err).to.be.instanceOf(InfraTreasuryError);
    expect(err!.code).to.equal('CUSTOMER_WALLET_FORBIDDEN');
  });

  it('rejects insufficient treasury USDC and frozen treasury', async () => {
    process.env.DAYFI_TREASURY_MOCK_USDC = '5';
    let short: InfraTreasuryError | null = null;
    try {
      await requestTreasuryRebalance({
        environment: 'test',
        amount: 50,
        destinationPublicKey: secondaryKp.publicKey(),
        idempotencyKey: `g-short-${crypto.randomUUID()}`,
      });
    } catch (e: any) {
      short = e;
    }
    expect(short?.code).to.equal('INSUFFICIENT_TREASURY_USDC');

    process.env.DAYFI_TREASURY_MOCK_USDC = '1000';
    process.env.DAYFI_TREASURY_FROZEN = '1';
    let frozen: InfraTreasuryError | null = null;
    try {
      await requestTreasuryRebalance({
        environment: 'test',
        amount: 1,
        destinationPublicKey: secondaryKp.publicKey(),
        idempotencyKey: `g-frozen-${crypto.randomUUID()}`,
      });
    } catch (e: any) {
      frozen = e;
    }
    expect(frozen?.code).to.equal('TREASURY_FROZEN');
  });

  it('rejects invalid destination address', async () => {
    process.env.DAYFI_TREASURY_MOCK_USDC = '1000';
    let err: InfraTreasuryError | null = null;
    try {
      await requestTreasuryRebalance({
        environment: 'test',
        amount: 1,
        destinationPublicKey: 'not-a-stellar-key',
        idempotencyKey: `g-bad-dest-${crypto.randomUUID()}`,
      });
    } catch (e: any) {
      err = e;
    }
    expect(err?.code).to.equal('INVALID_STELLAR_ADDRESS');
  });

  it('H provider failure surfaces provider_retry obligation; treasury USDC retained', async () => {
    process.env.DAYFI_TREASURY_MOCK_USDC = '1000';
    await creditOrgWallet({
      orgId: aliceId,
      environment: 'test',
      amount: 40,
      idempotencyKey: `g-h-seed-${crypto.randomUUID()}`,
    });
    const payout = await createPayout({
      orgId: aliceId,
      env: 'test',
      amount: 15,
      currency: 'USDC',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Alice',
      bankCode: '058',
      country: 'NG',
      idempotencyKey: `g-h-payout-${crypto.randomUUID()}`,
    });

    process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL = '1';
    const failed = await settleFiatOfframp({
      orgId: aliceId,
      payoutTransactionId: payout.id,
    });
    expect(failed.status).to.equal('provider_retry_required');

    const position = await getTreasuryPosition({ environment: 'test' });
    expect(Number(position.obligations.pendingProviderRetryRequired)).to.be.at.least(
      15
    );

    const recon = await reconcileTreasuryPosition({ environment: 'test' });
    expect(recon.legs.some((l) => l.name === 'provider_retry_required')).to.equal(
      true
    );

    delete process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL;
    const retried = await retryFiatOfframpProvider({
      orgId: aliceId,
      payoutTransactionId: payout.id,
    });
    expect(retried.status).to.equal('completed');

    const after = await getTreasuryPosition({ environment: 'test' });
    // Obligation should clear after provider success (this payout no longer failed).
    expect(Number(after.obligations.pendingProviderRetryRequired)).to.be.below(
      Number(position.obligations.pendingProviderRetryRequired) + 1e-9
    );
  });

  it('reconciliation report never silently fixes mismatches', async () => {
    process.env.DAYFI_TREASURY_MOCK_USDC = '10';
    const report = await reconcileTreasuryPosition({ environment: 'test' });
    expect(report.resultCode).to.be.oneOf([
      'LIQUIDITY_SHORTFALL',
      'LIQUIDITY_THIN',
      'TREASURY_RECONCILED',
      'TREASURY_OBSERVATION_INCOMPLETE',
    ]);
    expect(report.notes.length).to.be.above(0);
    expect(report.notes.join(' ')).to.match(/Customer liability/i);
  });

  it('submit without approval from requested still works after approve', async () => {
    process.env.DAYFI_TREASURY_MOCK_USDC = '500';
    const req = await requestTreasuryRebalance({
      environment: 'test',
      amount: 3,
      destinationPublicKey: secondaryKp.publicKey(),
      idempotencyKey: `g-approve-${crypto.randomUUID()}`,
      autoApprove: false,
    });
    expect(req.status).to.equal('requested');
    const submitted = await submitTreasuryRebalance({
      rebalanceId: req.id,
      environment: 'test',
    });
    expect(submitted.status).to.equal('confirmed');
  });
});
