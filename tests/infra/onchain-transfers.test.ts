/**
 * Increment E-ONCHAIN — Alice → Bob real Stellar (mock settlement) + Dayfi fee.
 *
 * Run: npm run test:infra-onchain-transfers
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
  InfraLedgerError,
} from '../../src/modules/infra/infraLedgerService';
import {
  createInternalTransfer,
  InfraTransferError,
} from '../../src/modules/infra/infraInternalTransferService';
import { ensureFeeRevenueOrg } from '../../src/modules/infra/infraFeeService';
import { provisionOrgStellarAccount } from '../../src/modules/infra/infraStellarAccountService';
import { runReconciliation } from '../../src/modules/infra/infraReconciliationService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `onchain-e-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Onchain E Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

async function seed(orgId: string, amount: number | string): Promise<void> {
  await creditOrgWallet({
    orgId,
    environment: 'test',
    amount,
    idempotencyKey: `eon-seed-${orgId}-${crypto.randomUUID()}`,
  });
}

describe('infra onchain transfers (Increment E-ONCHAIN)', function () {
  this.timeout(90000);
  let aliceId: string;
  let bobId: string;
  let feeOrgId: string;
  let alicePk: string;
  let bobPk: string;
  const feePayer = StellarSdk.Keypair.random();
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_internal_transfers') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-onchain-transfers');
    }
    for (const key of [
      'DAYFI_TRANSACTION_FEE_USDC',
      'DAYFI_INFRA_INTERNAL_TRANSFER_FEE',
      'DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE',
      'DAYFI_STELLAR_SETTLEMENT_MODE',
      'DAYFI_INFRA_STELLAR_PROVISION_MODE',
      'DAYFI_STELLAR_FEE_PAYER_MODE',
      'DAYFI_STELLAR_FEE_PAYER_ENABLED',
      'DAYFI_STELLAR_FEE_PAYER_MIN_XLM',
      'DAYFI_STELLAR_FEE_PAYER_MOCK_XLM',
      'DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY',
      'DAYFI_STELLAR_FEE_PAYER_SECRET',
      'DAYFI_INFRA_ONCHAIN_FORCE_FAIL',
      'DAYFI_INFRA_ONCHAIN_FORCE_CONFIRM_FAIL',
      'DAYFI_INFRA_ONCHAIN_FAIL_AFTER_LOCK',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.DAYFI_TRANSACTION_FEE_USDC = '0.01';
    process.env.DAYFI_INFRA_INTERNAL_TRANSFER_FEE = 'off';
    process.env.DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE = 'INTERNAL_LEDGER';
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
    process.env.DAYFI_STELLAR_FEE_PAYER_MIN_XLM = '5';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = feePayer.publicKey();
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = feePayer.secret();
    delete process.env.DAYFI_INFRA_ONCHAIN_FORCE_FAIL;
    delete process.env.DAYFI_INFRA_ONCHAIN_FORCE_CONFIRM_FAIL;
    delete process.env.DAYFI_INFRA_ONCHAIN_FAIL_AFTER_LOCK;

    aliceId = await createTestOrg('alice');
    bobId = await createTestOrg('bob');
    feeOrgId = await ensureFeeRevenueOrg();
    const aliceWallet = await provisionOrgStellarAccount({
      orgId: aliceId,
      environment: 'test',
      mode: 'mock',
    });
    const bobWallet = await provisionOrgStellarAccount({
      orgId: bobId,
      environment: 'test',
      mode: 'mock',
    });
    alicePk = aliceWallet.publicKey;
    bobPk = bobWallet.publicKey;
  });

  beforeEach(() => {
    process.env.DAYFI_STELLAR_SETTLEMENT_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = feePayer.secret();
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = feePayer.publicKey();
    delete process.env.DAYFI_INFRA_ONCHAIN_FORCE_FAIL;
    delete process.env.DAYFI_INFRA_ONCHAIN_FORCE_CONFIRM_FAIL;
    delete process.env.DAYFI_INFRA_ONCHAIN_FAIL_AFTER_LOCK;
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (aliceId) await cleanupOrg(aliceId);
    if (bobId) await cleanupOrg(bobId);
  });

  it('Alice → Bob $30 onchain: ledger 69.99/50, fee revenue 0.01, one settlement', async () => {
    await seed(aliceId, '100');
    await seed(bobId, '20');
    const feeBefore = await getOrgBalance(feeOrgId, 'test');

    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '30',
      recipientOrgId: bobId,
      settlementMode: 'STELLAR_ONCHAIN',
      idempotencyKey: `eon-happy-${crypto.randomUUID()}`,
    });

    expect(transfer.status).to.equal('completed');
    expect(transfer.settlementMode).to.equal('STELLAR_ONCHAIN');
    expect(transfer.stellarTouched).to.equal(true);
    expect(transfer.fee?.feeCharged).to.equal(true);
    expect(transfer.fee?.feeAmountUsdc).to.equal('0.01');
    expect(transfer.settlement?.stellarTransactionHash).to.match(/^[a-f0-9]{64}$/);
    expect(transfer.settlement?.sourcePublicKey).to.equal(alicePk);
    expect(transfer.settlement?.destinationPublicKey).to.equal(bobPk);
    expect(transfer.settlement?.feePayerPublicKey).to.equal(feePayer.publicKey());

    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    const feeAfter = await getOrgBalance(feeOrgId, 'test');
    expect(aliceAfter.available).to.equal(69.99);
    expect(bobAfter.available).to.equal(50);
    expect(Math.abs(feeAfter.available - (feeBefore.available + 0.01))).to.be.below(
      1e-9
    );
    expect(aliceAfter.locked).to.equal(0);

    const settlements = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE payout_transaction_id = $1 AND status = 'confirmed'`,
      [transfer.senderTransactionId]
    );
    expect(Number(settlements.n)).to.equal(1);
  });

  it('INTERNAL_LEDGER remains fee-off and Stellar-untouched', async () => {
    await seed(aliceId, '40');
    await seed(bobId, '10');
    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '15',
      recipientOrgId: bobId,
      settlementMode: 'INTERNAL_LEDGER',
      idempotencyKey: `eon-internal-${crypto.randomUUID()}`,
    });
    expect(transfer.settlementMode).to.equal('INTERNAL_LEDGER');
    expect(transfer.stellarTouched).to.equal(false);
    expect(transfer.fee?.feeCharged || false).to.equal(false);
    expect(transfer.settlement).to.equal(null);
  });

  it('idempotent replay returns same hash; no second debit/fee/credit', async () => {
    await seed(aliceId, '100');
    await seed(bobId, '20');
    const key = `eon-idem-${crypto.randomUUID()}`;
    const first = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '30',
      recipientOrgId: bobId,
      settlementMode: 'STELLAR_ONCHAIN',
      idempotencyKey: key,
    });
    const aliceMid = await getOrgBalance(aliceId, 'test');
    const bobMid = await getOrgBalance(bobId, 'test');
    const feeMid = await getOrgBalance(feeOrgId, 'test');

    const replay = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '30',
      recipientOrgId: bobId,
      settlementMode: 'STELLAR_ONCHAIN',
      idempotencyKey: key,
    });
    expect(replay.transferGroupId).to.equal(first.transferGroupId);
    expect(replay.settlement?.stellarTransactionHash).to.equal(
      first.settlement?.stellarTransactionHash
    );
    expect((await getOrgBalance(aliceId, 'test')).available).to.equal(
      aliceMid.available
    );
    expect((await getOrgBalance(bobId, 'test')).available).to.equal(
      bobMid.available
    );
    expect((await getOrgBalance(feeOrgId, 'test')).available).to.equal(
      feeMid.available
    );
  });

  it('insufficient Alice USDC does not debit or settle', async () => {
    await seed(aliceId, '10');
    const before = await getOrgBalance(aliceId, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: String(before.available + 100),
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `eon-insuf-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraLedgerError).code || (err as InfraTransferError).code;
    }
    expect(code).to.equal('INSUFFICIENT_BALANCE');
    expect((await getOrgBalance(aliceId, 'test')).available).to.equal(
      before.available
    );
  });

  it('insufficient Dayfi XLM reserve blocks submit with no spendable Bob credit', async () => {
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '0.1';
    await seed(aliceId, '100');
    await seed(bobId, '20');
    const bobBefore = await getOrgBalance(bobId, 'test');
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: '30',
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `eon-xlm-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as { code?: string }).code || '';
    }
    expect(code).to.equal('INSUFFICIENT_NETWORK_RESERVE');
    expect((await getOrgBalance(bobId, 'test')).available).to.equal(
      bobBefore.available
    );
    expect((await getOrgBalance(aliceId, 'test')).available).to.equal(
      aliceBefore.available
    );
  });

  it('Stellar submit failure releases locks; Bob not credited', async () => {
    process.env.DAYFI_INFRA_ONCHAIN_FORCE_FAIL = '1';
    await seed(aliceId, '100');
    await seed(bobId, '20');
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: '30',
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `eon-fail-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraTransferError).code;
    }
    expect(code).to.equal('STELLAR_SUBMIT_FAILED');
    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    expect(aliceAfter.locked).to.equal(aliceBefore.locked);
    expect(bobAfter.available).to.equal(bobBefore.available);
  });

  it('confirmation failure releases locks; no spendable Bob balance', async () => {
    process.env.DAYFI_INFRA_ONCHAIN_FORCE_CONFIRM_FAIL = '1';
    await seed(aliceId, '100');
    await seed(bobId, '20');
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: '30',
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `eon-confirm-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraTransferError).code;
    }
    expect(code).to.equal('STELLAR_CONFIRM_FAILED');
    expect((await getOrgBalance(aliceId, 'test')).available).to.equal(
      aliceBefore.available
    );
    expect((await getOrgBalance(bobId, 'test')).available).to.equal(
      bobBefore.available
    );
  });

  it('inactive Alice Stellar wallet fails without debit', async () => {
    const inactiveAlice = await createTestOrg('inactive-alice');
    await seed(inactiveAlice, '100');
    const before = await getOrgBalance(inactiveAlice, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: inactiveAlice,
        environment: 'test',
        amount: '30',
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `eon-inactive-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraTransferError).code;
    }
    expect(code).to.equal('SENDER_INACTIVE');
    expect((await getOrgBalance(inactiveAlice, 'test')).available).to.equal(
      before.available
    );
    await cleanupOrg(inactiveAlice);
  });

  it('reconciliation is RECONCILED for onchain sender/recipient', async () => {
    await seed(aliceId, '100');
    await seed(bobId, '20');
    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '30',
      recipientOrgId: bobId,
      settlementMode: 'STELLAR_ONCHAIN',
      idempotencyKey: `eon-recon-${crypto.randomUUID()}`,
    });

    const senderRecon = await runReconciliation({
      orgId: aliceId,
      environment: 'test',
      transactionIds: [transfer.senderTransactionId!],
      idempotencyKey: `recon-eon-out-${transfer.id}`,
      triggerSource: 'test',
    });
    const recipientRecon = await runReconciliation({
      orgId: bobId,
      environment: 'test',
      transactionIds: [transfer.recipientTransactionId!],
      idempotencyKey: `recon-eon-in-${transfer.id}`,
      triggerSource: 'test',
    });

    expect(senderRecon.items[0].resultCode).to.equal('RECONCILED');
    expect(senderRecon.items[0].settlement.required).to.equal(true);
    expect(senderRecon.items[0].settlement.present).to.equal(true);
    expect(recipientRecon.items[0].resultCode).to.equal('RECONCILED');
  });
});
