/**
 * Fee / custody architecture — USDC customer fee vs XLM network cost.
 *
 * Run: npm run test:infra-transaction-fees
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
import {
  addMinor,
  formatUsdc,
  parseUsdcToMinor,
} from '../../src/modules/infra/infraMoneyAmount';
import {
  ensureFeeRevenueOrg,
  preflightOnchainInternalTransfer,
  quoteDayfiTransactionFee,
} from '../../src/modules/infra/infraFeeService';
import {
  assertNetworkFeeReserve,
  getStellarFeePayerStatus,
  InfraFeePayerError,
} from '../../src/modules/infra/infraStellarFeePayerService';
import { provisionOrgStellarAccount } from '../../src/modules/infra/infraStellarAccountService';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `fee-test-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Fee Test ${suffix}`, slug]
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
    idempotencyKey: `fee-seed-${orgId}-${crypto.randomUUID()}`,
  });
}

describe('infra transaction fees (USDC fee vs XLM network cost)', function () {
  this.timeout(60000);
  let aliceId: string;
  let bobId: string;
  let feeOrgId: string;
  const saved: Record<string, string | undefined> = {};
  const feePayer = StellarSdk.Keypair.random();

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_transaction_fees') AS t`
    );
    if (!reg?.t) {
      throw new Error('Run migrations before test:infra-transaction-fees');
    }
    for (const key of [
      'DAYFI_TRANSACTION_FEE_USDC',
      'DAYFI_INFRA_INTERNAL_TRANSFER_FEE',
      'DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE',
      'DAYFI_STELLAR_FEE_PAYER_MODE',
      'DAYFI_STELLAR_FEE_PAYER_ENABLED',
      'DAYFI_STELLAR_FEE_PAYER_MIN_XLM',
      'DAYFI_STELLAR_FEE_PAYER_MOCK_XLM',
      'DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY',
      'DAYFI_STELLAR_FEE_PAYER_SECRET',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.DAYFI_TRANSACTION_FEE_USDC = '0.01';
    process.env.DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE = 'INTERNAL_LEDGER';
    process.env.DAYFI_STELLAR_FEE_PAYER_MODE = 'mock';
    process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED = 'true';
    process.env.DAYFI_STELLAR_FEE_PAYER_MIN_XLM = '5';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY = feePayer.publicKey();
    delete process.env.DAYFI_STELLAR_FEE_PAYER_SECRET;
    aliceId = await createTestOrg('alice');
    bobId = await createTestOrg('bob');
    feeOrgId = await ensureFeeRevenueOrg();
  });

  beforeEach(() => {
    process.env.DAYFI_INFRA_INTERNAL_TRANSFER_FEE = 'on';
    process.env.DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE = 'INTERNAL_LEDGER';
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (aliceId) await cleanupOrg(aliceId);
    if (bobId) await cleanupOrg(bobId);
  });

  it('I: fee math is integer-minor (30 + 0.01 = 30.01; 0.1 + 0.01 = 0.11)', () => {
    const a = addMinor(parseUsdcToMinor('30'), parseUsdcToMinor('0.01'));
    expect(formatUsdc(a)).to.equal('30.01');
    const b = addMinor(parseUsdcToMinor('0.1'), parseUsdcToMinor('0.01'));
    expect(formatUsdc(b)).to.equal('0.11');
    const quote = quoteDayfiTransactionFee({
      transferAmount: '30',
      chargeFee: true,
    });
    expect(quote.transferAmount).to.equal('30');
    expect(quote.feeAmountUsdc).to.equal('0.01');
    expect(quote.customerDebitAmount).to.equal('30.01');
    expect(quote.feeCurrency).to.equal('USDC');
    expect(quote.estimatedNetworkFeeCurrency).to.equal('XLM');
    expect(quote.actualNetworkFeeAmount).to.equal(null);
  });

  it('J: customer USDC fee is not labeled as the Stellar network fee', () => {
    const quote = quoteDayfiTransactionFee({
      transferAmount: '30',
      chargeFee: true,
    });
    expect(quote.feeType).to.equal('DAYFI_TRANSACTION_FEE');
    expect(quote.networkFeePayer).to.equal('DAYFI_XLM_RESERVE');
    expect(quote.feeAmountUsdc).to.not.equal(quote.estimatedNetworkFeeAmount);
    expect(quote.estimatedNetworkFeeAmount).to.equal('0.00001');
  });

  it('A: customer with transfer + fee succeeds; revenue recorded; Bob gets transfer only', async () => {
    await seed(aliceId, '30.01');
    await seed(bobId, '5');
    const feeBefore = await getOrgBalance(feeOrgId, 'test');
    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '30',
      recipientOrgId: bobId,
      idempotencyKey: `fee-a-${crypto.randomUUID()}`,
    });
    expect(transfer.settlementMode).to.equal('INTERNAL_LEDGER');
    expect(transfer.fee?.feeCharged).to.equal(true);
    expect(transfer.fee?.feeAmountUsdc).to.equal('0.01');
    expect(transfer.fee?.customerDebitAmount).to.equal('30.01');
    expect(transfer.fee?.actualNetworkFeeAmount).to.equal(null);
    const alice = await getOrgBalance(aliceId, 'test');
    const bob = await getOrgBalance(bobId, 'test');
    const feeAfter = await getOrgBalance(feeOrgId, 'test');
    expect(formatUsdc(parseUsdcToMinor(alice.available))).to.equal('0');
    expect(formatUsdc(parseUsdcToMinor(bob.available))).to.equal('35');
    expect(formatUsdc(parseUsdcToMinor(feeAfter.available))).to.equal(
      formatUsdc(addMinor(parseUsdcToMinor(feeBefore.available), parseUsdcToMinor('0.01')))
    );
  });

  it('B: customer with only the transfer amount cannot cover the fee', async () => {
    await seed(aliceId, '30');
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    const bobBefore = await getOrgBalance(bobId, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: '30',
        recipientOrgId: bobId,
        idempotencyKey: `fee-b-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraLedgerError).code;
    }
    expect(code).to.equal('INSUFFICIENT_BALANCE');
    const aliceAfter = await getOrgBalance(aliceId, 'test');
    const bobAfter = await getOrgBalance(bobId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    expect(bobAfter.available).to.equal(bobBefore.available);
  });

  it('C: Dayfi XLM reserve is sufficient (mock observation, no secret leaked)', async () => {
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    const status = await getStellarFeePayerStatus();
    expect(status.publicKey).to.equal(feePayer.publicKey());
    expect(status.hasSigningMaterial).to.equal(false);
    expect(JSON.stringify(status)).to.not.include(feePayer.secret());
    expect(status.sufficient).to.equal(true);
    expect(status.availableXlm).to.equal('100');
    const ok = await assertNetworkFeeReserve();
    expect(ok.sufficient).to.equal(true);
  });

  it('D: insufficient XLM reserve does not debit the customer', async () => {
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = feePayer.secret();
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '0.5';
    await provisionOrgStellarAccount({
      orgId: aliceId,
      environment: 'test',
      mode: 'mock',
    });
    await provisionOrgStellarAccount({
      orgId: bobId,
      environment: 'test',
      mode: 'mock',
    });
    await seed(aliceId, '50');
    const aliceBefore = await getOrgBalance(aliceId, 'test');
    let code = '';
    try {
      await assertNetworkFeeReserve();
    } catch (err) {
      code = (err as InfraFeePayerError).code;
    }
    expect(code).to.equal('INSUFFICIENT_NETWORK_RESERVE');
    try {
      await createInternalTransfer({
        senderOrgId: aliceId,
        environment: 'test',
        amount: '30',
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `fee-d-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraFeePayerError).code;
    }
    expect(code).to.equal('INSUFFICIENT_NETWORK_RESERVE');
    const aliceAfter = await getOrgBalance(aliceId, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
  });

  it('E+F: fee is charged exactly once; idempotent retry does not charge again', async () => {
    await seed(aliceId, '40');
    await seed(bobId, '1');
    const feeBefore = await getOrgBalance(feeOrgId, 'test');
    const key = `fee-ef-${crypto.randomUUID()}`;
    const first = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '10',
      recipientOrgId: bobId,
      idempotencyKey: key,
    });
    const second = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '10',
      recipientOrgId: bobId,
      idempotencyKey: key,
    });
    expect(second.duplicate).to.equal(true);
    expect(second.transferGroupId).to.equal(first.transferGroupId);
    const feeRows = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_transaction_fees
       WHERE transfer_group_id = $1`,
      [first.transferGroupId]
    );
    const feeDebits = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_ledger_movements
       WHERE movement_type = 'fee_debit' AND reference = $1`,
      [`fee:${first.transferGroupId}`]
    );
    expect(Number(feeRows.n)).to.equal(1);
    expect(Number(feeDebits.n)).to.equal(1);
    const feeAfter = await getOrgBalance(feeOrgId, 'test');
    expect(formatUsdc(parseUsdcToMinor(feeAfter.available))).to.equal(
      formatUsdc(addMinor(parseUsdcToMinor(feeBefore.available), parseUsdcToMinor('0.01')))
    );
  });

  it('G+H: INTERNAL_LEDGER creates zero Stellar txs; mock wallets are not used to pay XLM', async () => {
    process.env.DAYFI_INFRA_INTERNAL_TRANSFER_FEE = 'off';
    await provisionOrgStellarAccount({
      orgId: aliceId,
      environment: 'test',
      mode: 'mock',
    });
    await provisionOrgStellarAccount({
      orgId: bobId,
      environment: 'test',
      mode: 'mock',
    });
    await seed(aliceId, '20');
    const transfer = await createInternalTransfer({
      senderOrgId: aliceId,
      environment: 'test',
      amount: '5',
      recipientOrgId: bobId,
      idempotencyKey: `fee-gh-${crypto.randomUUID()}`,
    });
    expect(transfer.settlementMode).to.equal('INTERNAL_LEDGER');
    expect(transfer.stellarTouched).to.equal(false);
    expect(transfer.fee?.feeCharged).to.equal(false);
    const settlements = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM infra_settlements
       WHERE org_id IN ($1, $2)`,
      [aliceId, bobId]
    );
    expect(Number(settlements.n)).to.equal(0);
  });

  it('STELLAR_ONCHAIN does not debit when Alice Stellar wallet is inactive', async () => {
    process.env.DAYFI_STELLAR_FEE_PAYER_SECRET = feePayer.secret();
    process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM = '100';
    const bareAlice = await createTestOrg('bare-alice');
    await seed(bareAlice, '50');
    const aliceBefore = await getOrgBalance(bareAlice, 'test');
    let code = '';
    try {
      await createInternalTransfer({
        senderOrgId: bareAlice,
        environment: 'test',
        amount: '10',
        recipientOrgId: bobId,
        settlementMode: 'STELLAR_ONCHAIN',
        idempotencyKey: `fee-onchain-${crypto.randomUUID()}`,
      });
    } catch (err) {
      code = (err as InfraTransferError).code;
    }
    expect(code).to.equal('SENDER_INACTIVE');
    const aliceAfter = await getOrgBalance(bareAlice, 'test');
    expect(aliceAfter.available).to.equal(aliceBefore.available);
    const plan = await preflightOnchainInternalTransfer({
      senderOrgId: bareAlice,
      environment: 'test',
      amount: '10',
      recipientOrgId: bobId,
    });
    expect(plan.executed).to.equal(false);
    expect(plan.fee.feeCharged).to.equal(true);
    expect(plan.feePayer.publicKey).to.equal(feePayer.publicKey());
    await cleanupOrg(bareAlice);
  });
});
