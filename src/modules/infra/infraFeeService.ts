/**
 * Dayfi transaction fee model (USDC customer fee vs XLM network cost).
 *
 * Customer fee is a ledger revenue entry — never a separate Stellar USDC payment.
 * Stellar network fees are paid by the Dayfi XLM fee-paying account.
 */

import crypto from 'crypto';
import { db } from '../../config/database';
import {
  applyDayfiTransactionFee,
  bootstrapOrgWallets,
  getOrgBalance,
  InfraLedgerError,
  InfraLedgerTx,
} from './infraLedgerService';
import {
  addMinor,
  formatUsdc,
  parseUsdcToMinor,
  stellarBaseFeeXlm,
  usdcMinorToLedgerInput,
} from './infraMoneyAmount';
import { assertNetworkFeeReserve } from './infraStellarFeePayerService';

export type TransferSettlementMode = 'INTERNAL_LEDGER' | 'STELLAR_ONCHAIN';

export const FEE_TYPE_DAYFI_TRANSACTION = 'DAYFI_TRANSACTION_FEE';
/** Platform fee-revenue org slug — excluded from customer liability (Increment G). */
export const FEE_ORG_SLUG = 'dayfi-platform-fee-revenue';

export class InfraFeeError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraFeeError';
    this.code = code;
    this.status = status;
  }
}

export type DayfiFeeQuote = {
  feeAmountUsdc: string;
  feeCurrency: 'USDC';
  feeType: typeof FEE_TYPE_DAYFI_TRANSACTION;
  transferAmount: string;
  customerDebitAmount: string;
  feeCharged: boolean;
  feePolicyAmountUsdc: string;
  feeRevenueAmount: string;
  estimatedNetworkFeeAmount: string;
  estimatedNetworkFeeCurrency: 'XLM';
  actualNetworkFeeAmount: string | null;
  actualNetworkFeeCurrency: 'XLM';
  networkFeePayer: 'DAYFI_XLM_RESERVE';
};

export function getTransferSettlementMode(
  override?: string
): TransferSettlementMode {
  const raw = String(
    override || process.env.DAYFI_INFRA_TRANSFER_SETTLEMENT_MODE || ''
  )
    .trim()
    .toUpperCase()
    .replace(/-/g, '_');
  if (raw === 'STELLAR_ONCHAIN' || raw === 'ONCHAIN') return 'STELLAR_ONCHAIN';
  return 'INTERNAL_LEDGER';
}

export function isInternalTransferFeeEnabled(): boolean {
  const raw = String(process.env.DAYFI_INFRA_INTERNAL_TRANSFER_FEE || '')
    .trim()
    .toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

export function getConfiguredFeeUsdcMinor(): bigint {
  const raw = String(process.env.DAYFI_TRANSACTION_FEE_USDC || '0.01').trim();
  try {
    const n = parseUsdcToMinor(raw);
    return n < BigInt(0) ? BigInt(0) : n;
  } catch {
    return parseUsdcToMinor('0.01');
  }
}

export function quoteDayfiTransactionFee(input: {
  transferAmount: number | string;
  chargeFee: boolean;
}): DayfiFeeQuote {
  const transferMinor = parseUsdcToMinor(input.transferAmount);
  if (transferMinor <= BigInt(0)) {
    throw new InfraFeeError('Transfer amount must be positive', 'INVALID_AMOUNT');
  }
  const policyMinor = getConfiguredFeeUsdcMinor();
  const feeMinor = input.chargeFee ? policyMinor : BigInt(0);
  const customerDebit = addMinor(transferMinor, feeMinor);
  const estimated = stellarBaseFeeXlm();
  return {
    feeAmountUsdc: formatUsdc(feeMinor),
    feeCurrency: 'USDC',
    feeType: FEE_TYPE_DAYFI_TRANSACTION,
    transferAmount: formatUsdc(transferMinor),
    customerDebitAmount: formatUsdc(customerDebit),
    feeCharged: feeMinor > BigInt(0),
    feePolicyAmountUsdc: formatUsdc(policyMinor),
    feeRevenueAmount: formatUsdc(feeMinor),
    estimatedNetworkFeeAmount: estimated.formatted,
    estimatedNetworkFeeCurrency: 'XLM',
    actualNetworkFeeAmount: null,
    actualNetworkFeeCurrency: 'XLM',
    networkFeePayer: 'DAYFI_XLM_RESERVE',
  };
}

export function assertCustomerCanPay(input: {
  availableUsdc: number | string;
  transferAmount: number | string;
  feeAmountUsdc: number | string;
}): void {
  const available = parseUsdcToMinor(input.availableUsdc);
  const needed = addMinor(
    parseUsdcToMinor(input.transferAmount),
    parseUsdcToMinor(input.feeAmountUsdc)
  );
  if (available < needed) {
    throw new InfraLedgerError(
      `Insufficient available balance (have ${formatUsdc(available)}, need ${formatUsdc(needed)})`,
      'INSUFFICIENT_BALANCE',
      400
    );
  }
}

export async function ensureFeeRevenueOrg(): Promise<string> {
  const fromEnv = String(process.env.DAYFI_INFRA_FEE_ORG_ID || '').trim();
  if (fromEnv) return fromEnv;

  const existing = await db.oneOrNone<{ id: string }>(
    `SELECT id::text AS id FROM infra_organizations WHERE slug = $1`,
    [FEE_ORG_SLUG]
  );
  if (existing) {
    await bootstrapOrgWallets(existing.id);
    return existing.id;
  }

  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'verified')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id::text AS id`,
    ['Dayfi Platform Fee Revenue', FEE_ORG_SLUG]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

export async function loadFeeForTransfer(transferGroupId: string) {
  return db.oneOrNone<{
    id: string;
    fee_amount_usdc: string;
    fee_revenue_amount: string;
    customer_debit_amount: string;
    transfer_amount: string;
    actual_network_fee_amount: string | null;
    actual_network_fee_currency: string | null;
    settlement_mode: string;
    idempotency_key: string;
    status: string;
  }>(
    `SELECT id::text AS id, fee_amount_usdc::text, fee_revenue_amount::text,
            customer_debit_amount::text, transfer_amount::text,
            actual_network_fee_amount::text, actual_network_fee_currency,
            settlement_mode, idempotency_key, status
     FROM infra_transaction_fees
     WHERE transfer_group_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [transferGroupId]
  );
}

export async function recordTransferFee(input: {
  t: InfraLedgerTx;
  payerOrgId: string;
  environment: string;
  transferGroupId: string;
  senderTransactionId: string;
  quote: DayfiFeeQuote;
  settlementMode: TransferSettlementMode;
  idempotencyKey: string;
}): Promise<{ feeId: string; duplicate: boolean } | null> {
  if (!input.quote.feeCharged) return null;

  const existing = await input.t.oneOrNone<{ id: string }>(
    `SELECT id::text AS id FROM infra_transaction_fees WHERE idempotency_key = $1`,
    [input.idempotencyKey]
  );
  if (existing) return { feeId: existing.id, duplicate: true };

  const revenueOrgId = await ensureFeeRevenueOrg();
  const feeId = crypto.randomUUID();

  await input.t.none(
    `INSERT INTO infra_transaction_fees
       (id, org_id, environment, transfer_group_id, transaction_id, fee_type,
        fee_amount_usdc, fee_currency, transfer_amount, customer_debit_amount,
        actual_network_fee_amount, actual_network_fee_currency,
        fee_revenue_amount, fee_revenue_org_id, settlement_mode,
        idempotency_key, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'recorded',$17::jsonb)`,
    [
      feeId,
      input.payerOrgId,
      input.environment,
      input.transferGroupId,
      input.senderTransactionId,
      FEE_TYPE_DAYFI_TRANSACTION,
      input.quote.feeAmountUsdc,
      'USDC',
      input.quote.transferAmount,
      input.quote.customerDebitAmount,
      null,
      'XLM',
      input.quote.feeRevenueAmount,
      revenueOrgId,
      input.settlementMode,
      input.idempotencyKey,
      JSON.stringify({
        networkFeePayer: 'DAYFI_XLM_RESERVE',
        estimatedNetworkFeeAmount: input.quote.estimatedNetworkFeeAmount,
        estimatedNetworkFeeCurrency: 'XLM',
        customerFeeIsNotNetworkFee: true,
      }),
    ]
  );

  const posted = await applyDayfiTransactionFee({
    payerOrgId: input.payerOrgId,
    revenueOrgId,
    environment: input.environment,
    amount: usdcMinorToLedgerInput(parseUsdcToMinor(input.quote.feeAmountUsdc)),
    transferGroupId: input.transferGroupId,
    payerReferenceId: input.senderTransactionId,
    revenueReferenceId: feeId,
    debitIdempotencyKey: `${input.idempotencyKey}:debit`,
    creditIdempotencyKey: `${input.idempotencyKey}:revenue`,
    metadata: { feeId, feeType: FEE_TYPE_DAYFI_TRANSACTION },
    t: input.t,
  });

  if (posted) {
    await input.t.none(
      `UPDATE infra_transaction_fees SET
         customer_fee_movement_id = $2,
         revenue_movement_id = $3
       WHERE id = $1`,
      [feeId, posted.debit.id, posted.credit.id]
    );
  }

  return { feeId, duplicate: posted?.duplicate === true };
}

/**
 * Future STELLAR_ONCHAIN preflight. Does not submit a Stellar transaction.
 */
export async function preflightOnchainInternalTransfer(input: {
  senderOrgId: string;
  environment: string;
  amount: number | string;
  recipientOrgId: string;
}) {
  const quote = quoteDayfiTransactionFee({
    transferAmount: input.amount,
    chargeFee: true,
  });
  const sender = await getOrgBalance(input.senderOrgId, input.environment);
  assertCustomerCanPay({
    availableUsdc: sender.available,
    transferAmount: quote.transferAmount,
    feeAmountUsdc: quote.feeAmountUsdc,
  });
  const feePayer = await assertNetworkFeeReserve();
  return {
    mode: 'STELLAR_ONCHAIN' as const,
    executed: false,
    fee: quote,
    feePayer: {
      publicKey: feePayer.publicKey,
      network: feePayer.network,
      availableXlm: feePayer.availableXlm,
      sufficient: feePayer.sufficient,
    },
    note: 'Preflight only — does not submit. Execution uses createInternalTransfer with STELLAR_ONCHAIN.',
  };
}
