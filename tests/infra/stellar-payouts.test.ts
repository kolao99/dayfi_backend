/**
 * Increment F — org Stellar wallet → external USDC (Alice custody signing).
 *
 * Run: npm run test:infra-stellar-payouts
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
  getInfraStellarPayoutMode,
  getSettlementForPayout,
  InfraSettlementError,
  settlePayoutOnStellar,
} from '../../src/modules/infra/infraSettlementService';
import { runReconciliation } from '../../src/modules/infra/infraReconciliationService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `payout-f-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Payout F Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

describe('infra stellar org wallet payouts (Increment F)', function () {
  this.timeout(90000);
  let orgId: string;
  let alicePk: string;
  const externalDest = StellarSdk.Keypair.random().publicKey();
  const savedPayoutMode = process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE;
  const savedSettlementMode = process.env.DAYFI_STELLAR_SETTLEMENT_MODE;
  const savedProvisionMode = process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE;

  before(async () => {
    orgId = await createTestOrg('main');
  });

  beforeEach(async () => {
    process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = 'mock';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.STELLAR_NETWORK = 'testnet';
    const wallet = await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });
    alicePk = wallet.publicKey;
  });

  after(async () => {
    process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = savedPayoutMode;
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = savedSettlementMode;
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = savedProvisionMode;
    if (orgId) await cleanupOrg(orgId);
  });

  it('defaults payout mode to off outside this suite', () => {
    process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = '';
    expect(getInfraStellarPayoutMode()).to.equal('off');
    process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE = 'mock';
  });

  it('locks → org-wallet Stellar send → finalize; available decreases', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 100,
      idempotencyKey: `f-seed-${crypto.randomUUID()}`,
    });
    const before = await getOrgBalance(orgId, 'test');

    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 25,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: externalDest,
    });
    expect(payout.fundsLocked).to.equal(true);

    const locked = await getOrgBalance(orgId, 'test');
    expect(locked.available).to.equal(before.available - 25);
    expect(locked.locked).to.equal(before.locked + 25);

    const result = await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });

    expect(result.settlement.status).to.equal('confirmed');
    expect(result.settlement.sourceRef).to.equal(alicePk);
    expect(result.settlement.destinationRef).to.equal(externalDest);
    expect(result.settlement.railMetadata.signingSource).to.equal('org_wallet');
    expect(result.settlement.externalReference).to.match(/^[a-f0-9]{64}$/);

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available - 25);
    expect(after.locked).to.equal(before.locked);

    const recon = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [payout.id],
      idempotencyKey: `recon-f-${payout.id}`,
      triggerSource: 'test',
    });
    expect(recon.items[0].status).to.equal('reconciled');
    expect(recon.items[0].settlement.externalReference).to.equal(
      result.settlement.externalReference
    );
  });

  it('does not double-send on settle replay', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 50,
      idempotencyKey: `f-seed2-${crypto.randomUUID()}`,
    });
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 10,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: StellarSdk.Keypair.random().publicKey(),
    });
    const first = await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });
    const before = await getOrgBalance(orgId, 'test');
    const second = await settlePayoutOnStellar({
      orgId,
      payoutTransactionId: payout.id,
    });
    const after = await getOrgBalance(orgId, 'test');
    expect(second.settlement.id).to.equal(first.settlement.id);
    expect(second.settlement.externalReference).to.equal(
      first.settlement.externalReference
    );
    expect(after.available).to.equal(before.available);
  });

  it('rejects payout when available balance is insufficient (no lock)', async () => {
    const before = await getOrgBalance(orgId, 'test');
    let failed = false;
    try {
      await createPayout({
        orgId,
        env: 'test',
        amount: before.available + 1000,
        currency: 'USDC',
        accountType: 'crypto',
        asset: 'USDC',
        network: 'stellar',
        walletAddress: StellarSdk.Keypair.random().publicKey(),
      });
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available);
    expect(after.locked).to.equal(before.locked);
  });

  it('rejects invalid Stellar destination without debit', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 20,
      idempotencyKey: `f-seed3-${crypto.randomUUID()}`,
    });
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 5,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: 'not-a-valid-stellar-address',
    });
    let failed = false;
    try {
      await settlePayoutOnStellar({
        orgId,
        payoutTransactionId: payout.id,
      });
    } catch (err) {
      failed = true;
      expect(err).to.be.instanceOf(InfraSettlementError);
      expect((err as InfraSettlementError).code).to.equal('INVALID_ADDRESS');
    }
    expect(failed).to.equal(true);
    const bal = await getOrgBalance(orgId, 'test');
    expect(bal.locked).to.be.at.least(5);
    const settlement = await getSettlementForPayout(orgId, payout.id);
    expect(settlement).to.equal(null);
  });

  it('releases lock when Stellar submit fails', async () => {
    await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 30,
      idempotencyKey: `f-seed4-${crypto.randomUUID()}`,
    });
    const prePayout = await getOrgBalance(orgId, 'test');
    const payout = await createPayout({
      orgId,
      env: 'test',
      amount: 15,
      currency: 'USDC',
      accountType: 'crypto',
      asset: 'USDC',
      network: 'stellar',
      walletAddress: StellarSdk.Keypair.random().publicKey(),
    });
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
    const unfunded = StellarSdk.Keypair.random();
    let failed = false;
    try {
      await settlePayoutOnStellar({
        orgId,
        payoutTransactionId: payout.id,
        sourceSecret: unfunded.secret(),
      });
    } catch (err) {
      failed = true;
      expect(err).to.satisfy(
        (e: unknown) =>
          e instanceof InfraSettlementError ||
          e instanceof Error
      );
    }
    expect(failed).to.equal(true);
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(prePayout.available);
    expect(after.locked).to.equal(prePayout.locked);
    const tx = await db.one<{ status: string; metadata: Record<string, unknown> }>(
      `SELECT status, metadata FROM infra_transactions WHERE id = $1`,
      [payout.id]
    );
    expect(tx.metadata.fundsReleased).to.equal(true);
  });
});
