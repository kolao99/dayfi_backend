/**
 * Phase 5 — Stellar settlement vertical slice.
 *
 * Run: npm run test:infra-settlements
 *
 * Default adapter mode is mock (no network). Set DAYFI_STELLAR_SETTLEMENT_MODE=live
 * for real Testnet (requires funded DAYFI_STELLAR_SETTLEMENT_SECRET).
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
import { createPayout } from '../../src/modules/infra/infraMoneyService';
import {
  confirmStellarSettlement,
  getSettlementForPayout,
  InfraSettlementError,
  settlePayoutOnStellar,
} from '../../src/modules/infra/infraSettlementService';
import { getStellarSettlementMode } from '../../src/modules/infra/stellarSettlementAdapter';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `settle-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Settlement Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra settlements (Phase 5)', function () {
  this.timeout(60000);
  let orgId: string;
  const dest = StellarSdk.Keypair.random().publicKey();

  before(async () => {
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = 'off';
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_settlements') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-settlements');
    }
    expect(getStellarSettlementMode()).to.equal('mock');
    orgId = await createTestOrg('main');
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 1000,
      idempotencyKey: `settle-seed-${orgId}`,
    });
  });

  after(async () => {
    if (orgId) await cleanupOrg(orgId);
  });

  it('settles a locked crypto payout on Stellar and finalizes the Dayfi ledger', async () => {
    const before = await getOrgBalance(orgId, 'test');

    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 25,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: dest,
      accountName: 'Test Dest',
    });

    expect(payout.fundsLocked).to.equal(true);

    const mid = await getOrgBalance(orgId, 'test');
    expect(mid.available).to.equal(before.available - 25);
    expect(mid.locked).to.equal(before.locked + 25);

    const result = await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });

    expect(result.settlement.status).to.equal('confirmed');
    expect(result.settlement.rail).to.equal('STELLAR');
    expect(result.settlement.asset).to.equal('USDC');
    expect(result.settlement.amount).to.equal(25);
    expect(result.settlement.externalReference)
      .to.be.a('string')
      .and.have.length.greaterThan(10);
    expect(result.settlement.destinationRef).to.equal(dest);
    expect(result.settlement.railMetadata).to.have.property('stellar');

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available - 25);
    expect(after.locked).to.equal(before.locked);

    const tx = await db.one<{ status: string; metadata: Record<string, unknown> }>(
      `SELECT status, metadata FROM infra_transactions WHERE id = $1`,
      [payout.id]
    );
    expect(tx.metadata.fundsFinalized).to.equal(true);
    expect(tx.metadata.stellarTransactionHash).to.equal(
      result.settlement.externalReference
    );
    expect(tx.metadata.settlementId).to.equal(result.settlement.id);

    const again = await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });
    expect(again.settlement.id).to.equal(result.settlement.id);
    expect(again.settlement.status).to.equal('confirmed');
  });

  it('rejects non-crypto payouts', async () => {
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 10,
      currency: 'NGN',
      country: 'NG',
      accountType: 'bank',
      accountNumber: '0123456789',
      accountName: 'Bank User',
      bankCode: '058',
      bankName: 'GTBank',
    });

    try {
      await settlePayoutOnStellar({
        orgId,
        payoutTransactionId: payout.id,
      });
      expect.fail('should reject');
    } catch (err) {
      expect(err).to.be.instanceOf(InfraSettlementError);
      expect((err as InfraSettlementError).code).to.equal('UNSUPPORTED_METHOD');
    }
  });

  it('links settlement to payout for reconciliation', async () => {
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 5,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: StellarSdk.Keypair.random().publicKey(),
    });
    await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });
    const linked = await getSettlementForPayout(orgId, payout.id);
    expect(linked).to.not.equal(null);
    expect(linked!.payoutTransactionId).to.equal(payout.id);
    expect(linked!.status).to.equal('confirmed');

    const confirmed = await confirmStellarSettlement(orgId, linked!.id);
    expect(confirmed.settlement.status).to.equal('confirmed');
  });
});
