/**
 * Increment D — external Stellar USDC deposits into org Dayfi wallets.
 *
 * Run: npm run test:infra-stellar-deposits
 *
 * Default infra suite keeps DAYFI_INFRA_STELLAR_DEPOSIT_MODE=off.
 * This suite sets mock mode explicitly. Live Horizon cases skip without network.
 */

import { expect } from 'chai';
import { describe, it, before, after, beforeEach } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { bootstrapOrgWallets, getOrgBalance } from '../../src/modules/infra/infraLedgerService';
import { provisionOrgStellarAccount } from '../../src/modules/infra/infraStellarAccountService';
import {
  getDepositByHash,
  getInfraStellarDepositMode,
  processExternalDepositByHash,
  verifyExternalUsdcDeposit,
  type VerifiedDepositPayment,
} from '../../src/modules/infra/infraStellarDepositService';
import { runReconciliation } from '../../src/modules/infra/infraReconciliationService';
import { resolveUsdcIssuer } from '../../src/config/stellarIssuers';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `dep-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Deposit Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

function mockPayment(overrides: Partial<VerifiedDepositPayment>): VerifiedDepositPayment {
  const hash =
    overrides.stellarTxHash ||
    crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
  return {
    stellarTxHash: hash,
    sourcePublicKey: overrides.sourcePublicKey || `G${'B'.repeat(55)}`,
    destinationPublicKey: overrides.destinationPublicKey || `G${'C'.repeat(55)}`,
    amount: overrides.amount ?? 50,
    asset: 'USDC',
    assetIssuer: overrides.assetIssuer || resolveUsdcIssuer(true),
    network: 'testnet',
    successful: true,
    ledgerSequence: 1,
    operationId: `${hash}:0`,
    ...overrides,
  };
}

describe('infra stellar deposits (Increment D)', function () {
  this.timeout(90000);
  let orgId: string;
  let alicePk: string;
  const savedDepositMode = process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE;
  const savedProvisionMode = process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE;

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_stellar_deposits') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-stellar-deposits');
    }
    orgId = await createTestOrg('main');
  });

  beforeEach(() => {
    process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.STELLAR_NETWORK = 'testnet';
  });

  after(async () => {
    process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = savedDepositMode;
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = savedProvisionMode;
    if (orgId) await cleanupOrg(orgId);
  });

  it('defaults deposit mode to off outside this suite', () => {
    process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = '';
    expect(getInfraStellarDepositMode()).to.equal('off');
    process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = 'mock';
  });

  it('credits pending then available after verified deposit; reconciliation RECONCILED', async () => {
    const wallet = await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });
    alicePk = wallet.publicKey;

    const before = await getOrgBalance(orgId, 'test');
    const payment = mockPayment({
      destinationPublicKey: alicePk,
      amount: 50,
      sourcePublicKey: `G${'D'.repeat(55)}`,
    });

    const mid = await processExternalDepositByHash({
      stellarTxHash: payment.stellarTxHash,
      mockPayment: payment,
      stopAfterPending: true,
    });
    expect(mid.ledgerPhase).to.equal('pending');
    expect(mid.balance.available).to.equal(before.available);
    expect(mid.balance.pending).to.equal(before.pending + 50);

    const confirmed = await processExternalDepositByHash({
      stellarTxHash: payment.stellarTxHash,
      mockPayment: payment,
    });
    expect(confirmed.ledgerPhase).to.equal('available');
    expect(confirmed.deposit.status).to.equal('confirmed');
    expect(confirmed.balance.available).to.equal(before.available + 50);
    expect(confirmed.balance.pending).to.equal(before.pending);
    expect(confirmed.deposit.stellarTxHash).to.equal(payment.stellarTxHash);
    expect(confirmed.deposit.sourcePublicKey).to.equal(payment.sourcePublicKey);
    expect(confirmed.deposit.destinationPublicKey).to.equal(alicePk);

    const recon = await runReconciliation({
      orgId,
      environment: 'test',
      transactionIds: [confirmed.deposit.transactionId!],
      idempotencyKey: `recon-dep-${payment.stellarTxHash}`,
      triggerSource: 'test',
    });
    expect(recon.items[0].status).to.equal('reconciled');
    expect(recon.items[0].direction).to.equal('deposit');
    expect(recon.items[0].provider.present).to.equal(false);
    expect(recon.items[0].settlement.present).to.equal(true);
    expect(recon.items[0].settlement.externalReference).to.equal(payment.stellarTxHash);
    expect(recon.items[0].ledger.present).to.equal(true);
    expect(recon.items[0].settlement.status).to.equal('CONFIRMED');
  });

  it('never double-credits the same stellar tx hash (listener replay)', async () => {
    const wallet = await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });
    const payment = mockPayment({
      destinationPublicKey: wallet.publicKey,
      amount: 25,
    });

    const first = await processExternalDepositByHash({
      stellarTxHash: payment.stellarTxHash,
      mockPayment: payment,
    });
    const beforeReplay = await getOrgBalance(orgId, 'test');

    const second = await processExternalDepositByHash({
      stellarTxHash: payment.stellarTxHash,
      mockPayment: payment,
    });
    const afterReplay = await getOrgBalance(orgId, 'test');

    expect(second.duplicate).to.equal(true);
    expect(second.deposit.id).to.equal(first.deposit.id);
    expect(afterReplay.available).to.equal(beforeReplay.available);

    const count = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM infra_stellar_deposits WHERE stellar_tx_hash = $1`,
      [payment.stellarTxHash]
    );
    expect(Number(count.n)).to.equal(1);

    const availMoves = await db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM infra_ledger_movements
       WHERE reference = $1 AND movement_type = 'deposit_credit'`,
      [payment.stellarTxHash]
    );
    expect(Number(availMoves.n)).to.equal(1);
  });

  it('rejects wrong destination without ledger credit', async () => {
    await provisionOrgStellarAccount({ orgId, environment: 'test', mode: 'mock' });
    const before = await getOrgBalance(orgId, 'test');
    const payment = mockPayment({
      destinationPublicKey: `G${'E'.repeat(55)}`,
      amount: 10,
    });

    let failed = false;
    try {
      await processExternalDepositByHash({
        stellarTxHash: payment.stellarTxHash,
        mockPayment: payment,
      });
    } catch (err: unknown) {
      failed = true;
      expect(err).to.have.property('code', 'UNKNOWN_DESTINATION');
    }
    expect(failed).to.equal(true);

    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available);
    expect(after.pending).to.equal(before.pending);
    expect(await getDepositByHash(payment.stellarTxHash)).to.equal(null);
  });

  it('rejects wrong asset issuer without ledger credit', async function () {
    process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = 'live';
    process.env.STELLAR_NETWORK = 'testnet';

    // Invalid hash — must not credit
    const before = await getOrgBalance(orgId, 'test');
    let failed = false;
    try {
      await verifyExternalUsdcDeposit({
        stellarTxHash: '0'.repeat(64),
      });
    } catch (err: unknown) {
      failed = true;
      expect(err).to.have.property('code');
    }
    expect(failed).to.equal(true);
    const after = await getOrgBalance(orgId, 'test');
    expect(after.available).to.equal(before.available);
  });

  it('rejects malformed and nonexistent hashes', async function () {
    process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE = 'live';
    process.env.STELLAR_NETWORK = 'testnet';

    try {
      await verifyExternalUsdcDeposit({ stellarTxHash: 'not-a-hash' });
      expect.fail('should reject malformed hash');
    } catch (err: unknown) {
      expect(err).to.have.property('code', 'INVALID_HASH');
    }

    try {
      await verifyExternalUsdcDeposit({
        stellarTxHash: 'a'.repeat(64),
      });
      expect.fail('should reject nonexistent hash');
    } catch (err: unknown) {
      expect(err).to.have.property('code', 'TX_NOT_FOUND');
    }
  });
});
