/**
 * Increment C — collection wallet funding (treasury → org Stellar wallet).
 *
 * Run: npm run test:infra-stellar-funding
 *
 * Default infra suite keeps DAYFI_INFRA_STELLAR_FUNDING_MODE=off.
 * This suite sets mock/live funding modes explicitly.
 */

import { expect } from 'chai';
import { describe, it, before, after, beforeEach } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { bootstrapOrgWallets } from '../../src/modules/infra/infraLedgerService';
import { settleCollectionCredit } from '../../src/modules/infra/infraLifecycleService';
import { simulateSettlement } from '../../src/modules/infra/infraMoneyService';
import {
  getCollectionFundingSettlement,
  getInfraStellarFundingMode,
  fundCollectionStellarWallet,
} from '../../src/modules/infra/infraStellarFundingService';
import { provisionOrgStellarAccount } from '../../src/modules/infra/infraStellarAccountService';
import { runReconciliation } from '../../src/modules/infra/infraReconciliationService';
import { getStellarSettlementMode } from '../../src/modules/infra/stellarSettlementAdapter';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `fund-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Funding Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

async function insertPayment(orgId: string, amount: number): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
     VALUES ($1, 'test', $2, 'USDC', 'pending', 'bank_transfer', 'payment', 0, $3, $4::jsonb)
     RETURNING id::text AS id`,
    [
      orgId,
      amount,
      `seq-fund-${crypto.randomUUID()}`,
      JSON.stringify({
        type: 'collection',
        usdcAmount: amount,
        provider: 'provider',
        settlementSource: 'test',
      }),
    ]
  );
  return row.id;
}

describe('infra collection wallet funding (Increment C)', function () {
  this.timeout(90000);
  let orgId: string;
  const savedFundingMode = process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE;
  const savedSettlementMode = process.env.DAYFI_STELLAR_SETTLEMENT_MODE;
  const savedProvisionMode = process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE;

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_settlements') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-stellar-funding');
    }
    orgId = await createTestOrg('main');
  });

  beforeEach(() => {
    process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE = 'mock';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.STELLAR_NETWORK = 'testnet';
  });

  after(async () => {
    process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE = savedFundingMode;
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = savedSettlementMode;
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = savedProvisionMode;
    if (orgId) await cleanupOrg(orgId);
  });

  it('skips funding when DAYFI_INFRA_STELLAR_FUNDING_MODE=off', async () => {
    process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE = 'off';
    expect(getInfraStellarFundingMode()).to.equal('off');

    const paymentId = await insertPayment(orgId, 50);
    const result = await fundCollectionStellarWallet({
      orgId,
      environment: 'test',
      collectionTransactionId: paymentId,
      usdcAmount: 50,
    });
    expect(result.skipped).to.equal(true);
    expect(result.status).to.equal('skipped');

    const settlement = await getCollectionFundingSettlement(orgId, paymentId);
    expect(settlement).to.equal(null);
  });

  it('TEST B mock: provider simulate → pending then available + treasury funding + reconciliation', async () => {
    expect(getInfraStellarFundingMode()).to.equal('mock');
    expect(getStellarSettlementMode()).to.equal('mock');

    await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });

    const before = await db.one<{ available: string; pending: string }>(
      `SELECT available::text, pending::text FROM infra_wallet_accounts
       WHERE org_id = $1 AND environment = 'test' AND asset = 'USDC'`,
      [orgId]
    );

    const paymentId = await insertPayment(orgId, 100);
    const sim = (await simulateSettlement({
      orgId,
      env: 'test',
      transactionId: paymentId,
    })) as {
      usdcAmount: number;
      balance: { available: number; pending: number };
      ledgerPhase?: string;
      walletFunding?: {
        status: string;
        stellarTransactionHash?: string | null;
        destinationPublicKey?: string;
      };
    };

    expect(sim.usdcAmount).to.equal(100);
    expect(sim.ledgerPhase).to.equal('available');
    expect(sim.walletFunding?.status).to.equal('confirmed');
    expect(sim.balance.available).to.equal(Number(before.available) + 100);
    expect(sim.balance.pending).to.equal(Number(before.pending));
    expect(sim.walletFunding?.stellarTransactionHash).to.be.a('string').with.length.greaterThan(10);
    expect(sim.walletFunding?.destinationPublicKey).to.match(/^G[A-Z0-9]{55}$/);

    const settlement = await getCollectionFundingSettlement(orgId, paymentId);
    expect(settlement).to.not.equal(null);
    expect(settlement!.status).to.equal('confirmed');
    expect(settlement!.externalReference).to.equal(sim.walletFunding!.stellarTransactionHash);
    expect(settlement!.amount).to.equal(100);
    expect(settlement!.destinationRef).to.equal(sim.walletFunding!.destinationPublicKey);

    const tx = await db.one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM infra_transactions WHERE id = $1`,
      [paymentId]
    );
    const wf = tx.metadata.walletFunding as Record<string, unknown>;
    expect(wf.status).to.equal('confirmed');
    expect(wf.stellarTransactionHash).to.equal(sim.walletFunding!.stellarTransactionHash);

    const recon = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [paymentId],
      idempotencyKey: `recon-fund-${paymentId}`,
      triggerSource: 'test',
    });
    expect(recon.items[0].status).to.equal('reconciled');
    expect(recon.items[0].settlement.present).to.equal(true);
    expect(recon.items[0].settlement.status).to.equal('CONFIRMED');
    expect(recon.items[0].ledger.present).to.equal(true);
    const legsSettlement = recon.items[0].legs?.settlement as { ok?: boolean } | undefined;
    expect(legsSettlement?.ok).to.equal(true);
  });

  it('does not double-fund on collection credit replay (webhook retry)', async () => {
    const paymentId = await insertPayment(orgId, 75);
    const before = await db.one<{ available: string; pending: string }>(
      `SELECT available::text, pending::text FROM infra_wallet_accounts
       WHERE org_id = $1 AND environment = 'test' AND asset = 'USDC'`,
      [orgId]
    );

    const first = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-${paymentId}`,
      source: 'test',
    });
    expect(first.walletFunding?.status).to.equal('confirmed');
    expect(first.ledgerPhase).to.equal('available');
    expect(first.balance.available).to.equal(Number(before.available) + 75);
    expect(first.balance.pending).to.equal(Number(before.pending));
    const hash1 = first.walletFunding?.stellarTransactionHash;

    const second = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-retry-${paymentId}`,
      source: 'test',
    });
    expect(second.credit.duplicate).to.equal(true);
    expect(second.walletFunding?.status).to.equal('confirmed');
    expect(second.walletFunding?.stellarTransactionHash).to.equal(hash1);
    expect(second.balance.available).to.equal(first.balance.available);

    const count = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM infra_settlements
       WHERE collection_transaction_id = $1 AND status = 'confirmed'`,
      [paymentId]
    );
    expect(Number(count.n)).to.equal(1);

    const availMoves = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM infra_ledger_movements
       WHERE reference_id = $1 AND movement_type = 'collection_credit'`,
      [paymentId]
    );
    expect(Number(availMoves.n)).to.equal(1);
  });

  it('pending_treasury leaves entitlement in pending, not available', async function () {
    process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE = 'live';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'live';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';

    const secret = process.env.DAYFI_STELLAR_SETTLEMENT_SECRET?.trim();
    if (!secret || !/^S[A-Z0-9]{55}$/.test(secret)) {
      this.skip();
      return;
    }

    await provisionOrgStellarAccount({ orgId, environment: 'test', mode: 'mock' });
    const before = await db.one<{ available: string; pending: string }>(
      `SELECT available::text, pending::text FROM infra_wallet_accounts
       WHERE org_id = $1 AND environment = 'test' AND asset = 'USDC'`,
      [orgId]
    );

    const paymentId = await insertPayment(orgId, 999_999_999);
    const settled = await settleCollectionCredit({
      orgId,
      transactionId: paymentId,
      providerEventId: `evt-treasury-${paymentId}`,
      source: 'test',
    });

    expect(settled.walletFunding?.status).to.equal('pending_treasury');
    expect(settled.ledgerPhase).to.equal('pending');
    expect(settled.balance.available).to.equal(Number(before.available));
    expect(settled.balance.pending).to.be.at.least(Number(before.pending) + 999_999_999 - 0.01);
  });
});
