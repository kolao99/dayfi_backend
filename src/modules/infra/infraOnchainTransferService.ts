/**
 * Increment E-ONCHAIN — Alice Dayfi wallet → Bob Dayfi wallet on Stellar.
 *
 * Inner transaction: Alice authorizes USDC payment (Alice is the USDC source).
 * Fee-bump: Dayfi XLM fee-paying account pays the network fee.
 * Dayfi is never the USDC source. No treasury hop.
 *
 * Ledger: lock (available→locked) → submit → confirm → finalize.
 * Bob is credited only after Stellar confirmation.
 */

import crypto from 'crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import { getStellarConfig } from '../../config/stellarConfig';
import {
  creditOrgWallet,
  finalizeLockedDebit,
  getOrgBalance,
  InfraLedgerError,
  InfraLedgerTx,
  lockOrgFunds,
  releaseOrgFunds,
} from './infraLedgerService';
import {
  ensureFeeRevenueOrg,
  quoteDayfiTransactionFee,
  type DayfiFeeQuote,
} from './infraFeeService';
import {
  assertNetworkFeeReserve,
  getStellarFeePayerSigningSecret,
  getStellarFeePayerStatus,
} from './infraStellarFeePayerService';
import {
  getOrgStellarAccount,
  getOrgStellarSigningSecret,
  InfraStellarAccountError,
} from './infraStellarAccountService';
import {
  getStellarSettlementMode,
  prepareSponsoredUsdcPayment,
  StellarSettlementAdapterError,
  submitPreparedSponsoredPayment,
  verifyUsdcPayment,
} from './stellarSettlementAdapter';
import { formatUsdc, parseUsdcToMinor } from './infraMoneyAmount';
import { InfraTransferError } from './infraInternalTransferService';

export type OnchainTransferRow = {
  id: string;
  sender_org_id: string;
  recipient_org_id: string;
  environment: string;
  amount: string;
  asset: string;
  status: string;
  sender_transaction_id: string | null;
  recipient_transaction_id: string | null;
  sender_movement_id: string | null;
  recipient_movement_id: string | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  metadata: Record<string, unknown> | null;
  settlement_mode: string;
  fee_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const RETURNING = `id::text AS id,
  sender_org_id::text AS sender_org_id,
  recipient_org_id::text AS recipient_org_id,
  environment, amount::text, asset, status,
  sender_transaction_id::text AS sender_transaction_id,
  recipient_transaction_id::text AS recipient_transaction_id,
  sender_movement_id::text AS sender_movement_id,
  recipient_movement_id::text AS recipient_movement_id,
  idempotency_key, request_fingerprint, metadata,
  settlement_mode, fee_id::text AS fee_id, created_at, updated_at`;

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      String((err as { code?: string }).code) === '23505'
  );
}

async function walletActive(
  orgId: string,
  env: string,
  role: 'Alice' | 'Bob'
): Promise<void> {
  const row = await db.oneOrNone<{ status: string }>(
    `SELECT status FROM infra_wallet_accounts
     WHERE org_id = $1 AND environment = $2 AND asset = 'USDC'`,
    [orgId, env]
  );
  if (!row || row.status !== 'active') {
    throw new InfraTransferError(
      `${role} wallet is not active`,
      role === 'Alice' ? 'SENDER_INACTIVE' : 'RECIPIENT_INACTIVE',
      400
    );
  }
}

export async function assertUsdcTrustline(publicKey: string): Promise<void> {
  if (getStellarSettlementMode() === 'mock') return;
  const cfg = getStellarConfig();
  const issuer = resolveUsdcIssuer(true);
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const has = (
      account.balances as { asset_code?: string; asset_issuer?: string }[]
    ).some((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    if (!has) {
      throw new InfraTransferError(
        'Recipient has no USDC trustline',
        'MISSING_TRUSTLINE',
        400
      );
    }
  } catch (err) {
    if (err instanceof InfraTransferError) throw err;
    throw new InfraTransferError(
      'Recipient Stellar account is not ready',
      'MISSING_TRUSTLINE',
      400
    );
  }
}

async function releaseLocks(input: {
  senderOrgId: string;
  env: string;
  transferAmount: string;
  feeAmount: string;
  senderTxId: string;
}): Promise<void> {
  try {
    await releaseOrgFunds({
      orgId: input.senderOrgId,
      environment: input.env,
      amount: input.transferAmount,
      idempotencyKey: `internal_transfer:${input.senderTxId}:release`,
      movementType: 'funds_release',
      referenceType: 'internal_transfer',
      referenceId: input.senderTxId,
    });
  } catch {
    /* already released or never locked */
  }
  if (parseUsdcToMinor(input.feeAmount) > BigInt(0)) {
    try {
      await releaseOrgFunds({
        orgId: input.senderOrgId,
        environment: input.env,
        amount: input.feeAmount,
        idempotencyKey: `internal_transfer:${input.senderTxId}:fee_release`,
        movementType: 'funds_release',
        referenceType: 'transaction_fee',
        referenceId: input.senderTxId,
      });
    } catch {
      /* already released */
    }
  }
}

async function failTransfer(input: {
  row: OnchainTransferRow;
  reason: string;
  settlementId?: string | null;
  feeQuote: DayfiFeeQuote;
  code?: string;
}): Promise<never> {
  if (input.settlementId) {
    await db.none(
      `UPDATE infra_settlements SET
         status = 'failed',
         failure_reason = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [input.settlementId, input.reason.slice(0, 500)]
    );
  }
  if (input.row.sender_transaction_id) {
    await releaseLocks({
      senderOrgId: input.row.sender_org_id,
      env: input.row.environment,
      transferAmount: formatUsdc(parseUsdcToMinor(input.row.amount)),
      feeAmount: input.feeQuote.feeAmountUsdc,
      senderTxId: input.row.sender_transaction_id,
    });
    await db.none(
      `UPDATE infra_transactions SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = ANY($1::uuid[])`,
      [
        [input.row.sender_transaction_id, input.row.recipient_transaction_id].filter(
          Boolean
        ),
        JSON.stringify({ fundsReleased: true, failureReason: input.reason }),
      ]
    );
  }
  await db.none(
    `UPDATE infra_internal_transfers SET
       status = 'failed',
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [input.row.id, JSON.stringify({ failureReason: input.reason })]
  );
  throw new InfraTransferError(
    input.reason,
    input.code || 'STELLAR_SUBMIT_FAILED',
    502
  );
}

async function finalizeConfirmed(input: {
  row: OnchainTransferRow;
  payment: {
    transactionHash: string;
    sourceAccount: string;
    destinationAccount: string;
    amount: string;
    feePayerPublicKey: string;
    actualNetworkFeeXlm: string | null;
    actualNetworkFeeStroops: string | null;
    ledgerSequence: number | null;
  };
  feeQuote: DayfiFeeQuote;
  settlementId: string;
}): Promise<OnchainTransferRow> {
  const env = input.row.environment;
  const senderTxId = input.row.sender_transaction_id!;
  const recipientTxId = input.row.recipient_transaction_id!;
  const transferAmount = formatUsdc(parseUsdcToMinor(input.row.amount));
  const feeAmount = input.feeQuote.feeAmountUsdc;
  const revenueOrgId = await ensureFeeRevenueOrg();

  const debit = await finalizeLockedDebit({
    orgId: input.row.sender_org_id,
    environment: env,
    amount: transferAmount,
    idempotencyKey: `internal_transfer:${senderTxId}:finalize`,
    movementType: 'internal_transfer_debit',
    referenceType: 'internal_transfer',
    referenceId: senderTxId,
    reference: input.row.id,
    metadata: {
      transferGroupId: input.row.id,
      settlementMode: 'STELLAR_ONCHAIN',
      stellarTransactionHash: input.payment.transactionHash,
    },
  });

  const credit = await creditOrgWallet({
    orgId: input.row.recipient_org_id,
    environment: env,
    amount: transferAmount,
    idempotencyKey: `internal_transfer:${recipientTxId}:credit`,
    movementType: 'internal_transfer_credit',
    referenceType: 'internal_transfer',
    referenceId: recipientTxId,
    reference: input.row.id,
    metadata: {
      transferGroupId: input.row.id,
      settlementMode: 'STELLAR_ONCHAIN',
      stellarTransactionHash: input.payment.transactionHash,
    },
  });

  let feeId: string | null = input.row.fee_id;
  if (input.feeQuote.feeCharged) {
    await finalizeLockedDebit({
      orgId: input.row.sender_org_id,
      environment: env,
      amount: feeAmount,
      idempotencyKey: `internal_transfer:${senderTxId}:fee_finalize`,
      movementType: 'fee_debit',
      referenceType: 'transaction_fee',
      referenceId: senderTxId,
      reference: `fee:${input.row.id}`,
      metadata: {
        transferGroupId: input.row.id,
        feeType: 'DAYFI_TRANSACTION_FEE',
        stellarTransactionHash: input.payment.transactionHash,
      },
    });
    await creditOrgWallet({
      orgId: revenueOrgId,
      environment: env,
      amount: feeAmount,
      idempotencyKey: `internal_transfer:${senderTxId}:fee_revenue`,
      movementType: 'fee_revenue',
      referenceType: 'transaction_fee',
      referenceId: feeId || senderTxId,
      reference: `fee:${input.row.id}`,
      metadata: {
        transferGroupId: input.row.id,
        feeType: 'DAYFI_TRANSACTION_FEE',
      },
    });

    const feeKey = `transfer:${input.row.idempotency_key || input.row.id}:fee`;
    const existingFee = await db.oneOrNone<{ id: string }>(
      `SELECT id::text AS id FROM infra_transaction_fees WHERE idempotency_key = $1`,
      [feeKey]
    );
    if (existingFee) {
      feeId = existingFee.id;
      await db.none(
        `UPDATE infra_transaction_fees SET
           actual_network_fee_amount = $2,
           actual_network_fee_currency = 'XLM',
           status = 'recorded',
           metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
         WHERE id = $1`,
        [
          existingFee.id,
          input.payment.actualNetworkFeeXlm,
          JSON.stringify({
            actualNetworkFeeStroops: input.payment.actualNetworkFeeStroops,
            feePayerPublicKey: input.payment.feePayerPublicKey,
            customerFeeIsNotNetworkFee: true,
          }),
        ]
      );
    } else {
      const inserted = await db.one<{ id: string }>(
        `INSERT INTO infra_transaction_fees
           (org_id, environment, transfer_group_id, transaction_id, fee_type,
            fee_amount_usdc, fee_currency, transfer_amount, customer_debit_amount,
            actual_network_fee_amount, actual_network_fee_currency,
            fee_revenue_amount, fee_revenue_org_id, settlement_mode,
            idempotency_key, status, metadata)
         VALUES ($1,$2,$3,$4,'DAYFI_TRANSACTION_FEE',$5,'USDC',$6,$7,$8,'XLM',$5,$9,
                 'STELLAR_ONCHAIN',$10,'recorded',$11::jsonb)
         RETURNING id::text AS id`,
        [
          input.row.sender_org_id,
          env,
          input.row.id,
          senderTxId,
          feeAmount,
          transferAmount,
          input.feeQuote.customerDebitAmount,
          input.payment.actualNetworkFeeXlm,
          revenueOrgId,
          feeKey,
          JSON.stringify({
            actualNetworkFeeStroops: input.payment.actualNetworkFeeStroops,
            feePayerPublicKey: input.payment.feePayerPublicKey,
            estimatedNetworkFeeAmount: input.feeQuote.estimatedNetworkFeeAmount,
            customerFeeIsNotNetworkFee: true,
          }),
        ]
      );
      feeId = inserted.id;
    }
  }

  await db.none(
    `UPDATE infra_settlements SET
       status = 'confirmed',
       external_reference = $2,
       provider_reference = $2,
       source_ref = $3,
       destination_ref = $4,
       confirmed_at = CURRENT_TIMESTAMP,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $5::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      input.settlementId,
      input.payment.transactionHash,
      input.payment.sourceAccount,
      input.payment.destinationAccount,
      JSON.stringify({
        stellar: {
          transactionHash: input.payment.transactionHash,
          ledgerSequence: input.payment.ledgerSequence,
          usdcIssuer: resolveUsdcIssuer(true),
          amount: input.payment.amount,
          envelopeType: 'FEE_BUMP',
        },
        signingSource: 'org_wallet',
        usdcSource: input.payment.sourceAccount,
        feePayerPublicKey: input.payment.feePayerPublicKey,
        actualNetworkFeeXlm: input.payment.actualNetworkFeeXlm,
        actualNetworkFeeStroops: input.payment.actualNetworkFeeStroops,
      }),
    ]
  );

  await db.none(
    `UPDATE infra_transactions SET
       status = 'completed',
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = ANY($1::uuid[])`,
    [
      [senderTxId, recipientTxId],
      JSON.stringify({
        stellarTransactionHash: input.payment.transactionHash,
        fundsFinalized: true,
        fundsLocked: true,
      }),
    ]
  );

  return db.one<OnchainTransferRow>(
    `UPDATE infra_internal_transfers SET
       status = 'completed',
       sender_movement_id = $2,
       recipient_movement_id = $3,
       fee_id = COALESCE($4, fee_id),
       metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${RETURNING}`,
    [
      input.row.id,
      debit.id,
      credit.id,
      feeId,
      JSON.stringify({
        stellarTouched: true,
        stellarTransactionHash: input.payment.transactionHash,
        usdcSource: input.payment.sourceAccount,
        feePayerPublicKey: input.payment.feePayerPublicKey,
        actualNetworkFeeXlm: input.payment.actualNetworkFeeXlm,
      }),
    ]
  );
}

export async function confirmOnchainInternalTransfer(
  row: OnchainTransferRow
): Promise<OnchainTransferRow> {
  if (row.status === 'completed') return row;
  const settlement = await db.oneOrNone<{
    id: string;
    status: string;
    external_reference: string | null;
    destination_ref: string | null;
    source_ref: string | null;
    rail_metadata: Record<string, unknown> | null;
  }>(
    `SELECT id::text AS id, status, external_reference, destination_ref, source_ref,
            rail_metadata
     FROM infra_settlements
     WHERE org_id = $1 AND idempotency_key = $2`,
    [row.sender_org_id, `stellar:internal_transfer:${row.id}`]
  );
  if (!settlement?.external_reference) {
    throw new InfraTransferError(
      'On-chain transfer has no Stellar hash to confirm',
      'NO_EXTERNAL_REF',
      409
    );
  }
  const verified = await verifyUsdcPayment(settlement.external_reference);
  const feeQuote =
    ((row.metadata || {}).fee as DayfiFeeQuote) ||
    quoteDayfiTransactionFee({ transferAmount: row.amount, chargeFee: true });
  if (!verified.confirmed) {
    if (String(verified.status || '').toUpperCase().includes('FAIL')) {
      await failTransfer({
        row,
        reason: `On-chain failure: ${verified.status}`,
        settlementId: settlement.id,
        feeQuote,
      });
    }
    throw new InfraTransferError(
      `Settlement not confirmed on-chain (status=${verified.status})`,
      'NOT_CONFIRMED',
      409
    );
  }
  const meta = settlement.rail_metadata || {};
  const stellar = (meta.stellar || {}) as Record<string, unknown>;
  return finalizeConfirmed({
    row,
    feeQuote,
    settlementId: settlement.id,
    payment: {
      transactionHash: settlement.external_reference,
      sourceAccount: String(meta.usdcSource || settlement.source_ref || ''),
      destinationAccount: String(
        stellar.destination || settlement.destination_ref || ''
      ),
      amount: formatUsdc(parseUsdcToMinor(row.amount)),
      feePayerPublicKey: String(meta.feePayerPublicKey || ''),
      actualNetworkFeeXlm:
        typeof meta.actualNetworkFeeXlm === 'string'
          ? meta.actualNetworkFeeXlm
          : null,
      actualNetworkFeeStroops:
        typeof meta.actualNetworkFeeStroops === 'string'
          ? meta.actualNetworkFeeStroops
          : null,
      ledgerSequence:
        typeof stellar.ledgerSequence === 'number'
          ? stellar.ledgerSequence
          : null,
    },
  });
}

export async function executeOnchainInternalTransfer(input: {
  senderOrgId: string;
  recipientOrgId: string;
  environment: string;
  amount: string;
  idempotencyKey: string | null;
  fingerprint: string;
  reason?: string;
}): Promise<OnchainTransferRow> {
  const env = input.environment === 'live' ? 'live' : 'test';
  const feeQuote = quoteDayfiTransactionFee({
    transferAmount: input.amount,
    chargeFee: true,
  });

  await walletActive(input.senderOrgId, env, 'Alice');
  await walletActive(input.recipientOrgId, env, 'Bob');

  const aliceWallet = await getOrgStellarAccount(input.senderOrgId, env);
  const bobWallet = await getOrgStellarAccount(input.recipientOrgId, env);
  if (!aliceWallet || aliceWallet.status !== 'active') {
    throw new InfraTransferError(
      'Alice Stellar wallet is not active',
      'SENDER_INACTIVE',
      400
    );
  }
  if (!bobWallet || bobWallet.status !== 'active') {
    throw new InfraTransferError(
      'Bob Stellar wallet is not active',
      'RECIPIENT_INACTIVE',
      400
    );
  }
  if (aliceWallet.network !== bobWallet.network) {
    throw new InfraTransferError(
      'Cross-network transfers are not allowed',
      'CROSS_ENVIRONMENT',
      400
    );
  }
  if (aliceWallet.publicKey === bobWallet.publicKey) {
    throw new InfraTransferError(
      'Cannot send to the same Stellar wallet',
      'SELF_TRANSFER',
      400
    );
  }

  const senderBal = await getOrgBalance(input.senderOrgId, env);
  if (senderBal.available + 1e-12 < Number(feeQuote.customerDebitAmount)) {
    throw new InfraLedgerError(
      `Insufficient available balance (have ${senderBal.available}, need ${feeQuote.customerDebitAmount})`,
      'INSUFFICIENT_BALANCE',
      400
    );
  }

  await assertUsdcTrustline(bobWallet.publicKey);
  await assertNetworkFeeReserve();
  await ensureFeeRevenueOrg();

  const aliceSigning = await getOrgStellarSigningSecret(input.senderOrgId, env);
  const feePayerStatus = await getStellarFeePayerStatus();
  const feePayerSecret = getStellarFeePayerSigningSecret();
  const feePayerPk = StellarSdk.Keypair.fromSecret(feePayerSecret).publicKey();
  if (feePayerStatus.publicKey && feePayerStatus.publicKey !== feePayerPk) {
    throw new InfraTransferError(
      'Fee-payer public key does not match signing material',
      'FEE_PAYER_MISMATCH',
      500
    );
  }
  if (feePayerPk === aliceWallet.publicKey || feePayerPk === bobWallet.publicKey) {
    throw new InfraTransferError(
      'Dayfi fee-payer must not be Alice or Bob',
      'FEE_PAYER_IS_SOURCE',
      400
    );
  }

  let row: OnchainTransferRow;
  try {
    row = await db.tx(async (t) => {
      const tx = t as unknown as InfraLedgerTx;
      const transfer = await tx.one<OnchainTransferRow>(
        `INSERT INTO infra_internal_transfers
           (id, sender_org_id, recipient_org_id, environment, amount, asset, status,
            idempotency_key, request_fingerprint, metadata, settlement_mode)
         VALUES ($1,$2,$3,$4,$5,'USDC','processing',$6,$7,$8::jsonb,'STELLAR_ONCHAIN')
         RETURNING ${RETURNING}`,
        [
          crypto.randomUUID(),
          input.senderOrgId,
          input.recipientOrgId,
          env,
          input.amount,
          input.idempotencyKey,
          input.fingerprint,
          JSON.stringify({
            type: 'internal_transfer',
            reason: input.reason || null,
            stellarTouched: true,
            settlementMode: 'STELLAR_ONCHAIN',
            fee: feeQuote,
          }),
        ]
      );

      const sharedTxMeta = {
        type: 'internal_transfer',
        transferGroupId: transfer.id,
        usdcAmount: Number(input.amount),
        rail: 'stellar',
        stellarTouched: true,
        settlementRail: 'STELLAR',
        settlementMode: 'STELLAR_ONCHAIN',
        fee: feeQuote,
      };

      const senderTx = await tx.one<{ id: string }>(
        `INSERT INTO infra_transactions
           (org_id, environment, amount, currency, status, method, direction, fee,
            external_id, metadata, client_idempotency_key, request_fingerprint)
         VALUES ($1,$2,$3,'USDC','processing','internal_transfer','internal_transfer',
                 $4,$5,$6::jsonb,$7,$8)
         RETURNING id::text AS id`,
        [
          input.senderOrgId,
          env,
          input.amount,
          feeQuote.feeAmountUsdc,
          `internal-transfer:${transfer.id}:out`,
          JSON.stringify({
            ...sharedTxMeta,
            role: 'sender',
            counterpartyOrgId: input.recipientOrgId,
          }),
          input.idempotencyKey ? `${input.idempotencyKey}:out` : null,
          input.fingerprint,
        ]
      );
      const recipientTx = await tx.one<{ id: string }>(
        `INSERT INTO infra_transactions
           (org_id, environment, amount, currency, status, method, direction, fee,
            external_id, metadata, client_idempotency_key, request_fingerprint)
         VALUES ($1,$2,$3,'USDC','processing','internal_transfer','internal_transfer',
                 0,$4,$5::jsonb,$6,$7)
         RETURNING id::text AS id`,
        [
          input.recipientOrgId,
          env,
          input.amount,
          `internal-transfer:${transfer.id}:in`,
          JSON.stringify({
            ...sharedTxMeta,
            role: 'recipient',
            counterpartyOrgId: input.senderOrgId,
          }),
          input.idempotencyKey ? `${input.idempotencyKey}:in` : null,
          input.fingerprint,
        ]
      );

      await tx.one<{ id: string }>(
        `INSERT INTO infra_settlements
           (org_id, environment, payout_transaction_id, collection_transaction_id,
            rail, asset, amount, destination_ref, source_ref, status, idempotency_key,
            rail_metadata)
         VALUES ($1,$2,$3,$4,'STELLAR','USDC',$5,$6,$7,'pending',$8,$9::jsonb)
         RETURNING id::text AS id`,
        [
          input.senderOrgId,
          env,
          senderTx.id,
          recipientTx.id,
          input.amount,
          bobWallet.publicKey,
          aliceWallet.publicKey,
          `stellar:internal_transfer:${transfer.id}`,
          JSON.stringify({
            envelopeType: 'FEE_BUMP',
            usdcSource: aliceWallet.publicKey,
            feePayerPublicKey: feePayerPk,
            signingSource: 'org_wallet',
          }),
        ]
      );

      return tx.one<OnchainTransferRow>(
        `UPDATE infra_internal_transfers SET
           sender_transaction_id = $2,
           recipient_transaction_id = $3,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING ${RETURNING}`,
        [transfer.id, senderTx.id, recipientTx.id]
      );
    });
  } catch (err) {
    if (isUniqueViolation(err) && input.idempotencyKey) {
      const existing = await db.oneOrNone<OnchainTransferRow>(
        `SELECT ${RETURNING} FROM infra_internal_transfers
         WHERE sender_org_id = $1 AND environment = $2 AND idempotency_key = $3`,
        [input.senderOrgId, env, input.idempotencyKey]
      );
      if (existing?.status === 'completed' || existing?.status === 'failed') {
        return existing;
      }
      if (existing) row = existing;
      else throw err;
    } else {
      throw err;
    }
  }

  if (row.status === 'completed') return row;

  const settlement = await db.one<{
    id: string;
    external_reference: string | null;
    status: string;
    rail_metadata: Record<string, unknown> | null;
  }>(
    `SELECT id::text AS id, external_reference, status, rail_metadata
     FROM infra_settlements
     WHERE idempotency_key = $1`,
    [`stellar:internal_transfer:${row.id}`]
  );

  if (String(process.env.DAYFI_INFRA_ONCHAIN_FAIL_BEFORE_LOCK || '') === '1') {
    throw new InfraTransferError(
      'Simulated DB failure before lock',
      'SIMULATED_DB_FAILURE',
      500
    );
  }

  if (!row.sender_transaction_id) {
    throw new InfraTransferError(
      'On-chain transfer is missing sender transaction',
      'TRANSFER_INCOMPLETE',
      500
    );
  }

  await lockOrgFunds({
    orgId: input.senderOrgId,
    environment: env,
    amount: input.amount,
    idempotencyKey: `internal_transfer:${row.sender_transaction_id}:lock`,
    movementType: 'funds_lock',
    referenceType: 'internal_transfer',
    referenceId: row.sender_transaction_id,
    reference: row.id,
    metadata: { transferGroupId: row.id, role: 'transfer_lock' },
  });
  if (feeQuote.feeCharged) {
    await lockOrgFunds({
      orgId: input.senderOrgId,
      environment: env,
      amount: feeQuote.feeAmountUsdc,
      idempotencyKey: `internal_transfer:${row.sender_transaction_id}:fee_lock`,
      movementType: 'funds_lock',
      referenceType: 'transaction_fee',
      referenceId: row.sender_transaction_id,
      reference: `fee:${row.id}`,
      metadata: { transferGroupId: row.id, role: 'fee_lock' },
    });
  }

  if (String(process.env.DAYFI_INFRA_ONCHAIN_FAIL_AFTER_LOCK || '') === '1') {
    await failTransfer({
      row,
      reason: 'Simulated DB failure after lock',
      settlementId: settlement.id,
      feeQuote,
      code: 'SIMULATED_DB_FAILURE',
    });
  }

  const meta = settlement.rail_metadata || {};
  if (settlement.external_reference && settlement.status !== 'failed') {
    const verified = await verifyUsdcPayment(settlement.external_reference);
    if (verified.confirmed) {
      return confirmOnchainInternalTransfer(row);
    }
  }

  let prepared = {
    xdr: typeof meta.pendingEnvelopeXdr === 'string' ? meta.pendingEnvelopeXdr : '',
    transactionHash:
      settlement.external_reference ||
      (typeof meta.pendingTransactionHash === 'string'
        ? meta.pendingTransactionHash
        : ''),
    innerSourcePublicKey: aliceWallet.publicKey,
    feePayerPublicKey: feePayerPk,
    destinationAccount: bobWallet.publicKey,
    amount: input.amount,
    envelopeType: 'FEE_BUMP' as const,
  };
  if (!prepared.xdr || !prepared.transactionHash) {
    prepared = await prepareSponsoredUsdcPayment({
      destination: bobWallet.publicKey,
      amount: input.amount,
      memo: `dayfi:${String(row.id).replace(/-/g, '').slice(0, 24)}`,
      sourceSecret: aliceSigning.secret,
      feePayerSecret,
    });
    await db.none(
      `UPDATE infra_settlements SET
         external_reference = $2,
         rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $3::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        settlement.id,
        prepared.transactionHash,
        JSON.stringify({
          pendingEnvelopeXdr: prepared.xdr,
          pendingTransactionHash: prepared.transactionHash,
          usdcSource: prepared.innerSourcePublicKey,
          feePayerPublicKey: prepared.feePayerPublicKey,
          envelopeType: 'FEE_BUMP',
        }),
      ]
    );
  }

  if (prepared.innerSourcePublicKey !== aliceWallet.publicKey) {
    await failTransfer({
      row,
      reason: 'USDC source was not Alice',
      settlementId: settlement.id,
      feeQuote,
    });
  }

  const payment = await submitPreparedSponsoredPayment(prepared).catch(
    async (err: unknown) => {
      const reason =
        err instanceof StellarSettlementAdapterError ||
        err instanceof InfraStellarAccountError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Stellar submit failed';
      return failTransfer({
        row,
        reason,
        settlementId: settlement.id,
        feeQuote,
      });
    }
  );

  await db.none(
    `UPDATE infra_settlements SET
       status = 'submitted',
       external_reference = $2,
       provider_reference = $2,
       source_ref = $3,
       destination_ref = $4,
       submitted_at = CURRENT_TIMESTAMP,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $5::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      settlement.id,
      payment.transactionHash,
      payment.sourceAccount,
      payment.destinationAccount,
      JSON.stringify({
        stellar: {
          transactionHash: payment.transactionHash,
          ledgerSequence: payment.ledgerSequence,
          amount: payment.amount,
          envelopeType: 'FEE_BUMP',
        },
        usdcSource: payment.innerSourcePublicKey,
        feePayerPublicKey: payment.feePayerPublicKey,
        actualNetworkFeeXlm: payment.actualNetworkFeeXlm,
        actualNetworkFeeStroops: payment.actualNetworkFeeStroops,
      }),
    ]
  );
  await db.none(
    `UPDATE infra_internal_transfers SET status = 'submitted',
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [row.id, JSON.stringify({ stellarTransactionHash: payment.transactionHash })]
  );

  const refreshed = await db.one<OnchainTransferRow>(
    `SELECT ${RETURNING} FROM infra_internal_transfers WHERE id = $1`,
    [row.id]
  );

  if (String(process.env.DAYFI_INFRA_ONCHAIN_FORCE_CONFIRM_FAIL || '') === '1') {
    await failTransfer({
      row: refreshed,
      reason: 'Forced Stellar confirmation failure',
      settlementId: settlement.id,
      feeQuote,
      code: 'STELLAR_CONFIRM_FAILED',
    });
  }

  const verified = await verifyUsdcPayment(payment.transactionHash);
  if (
    getStellarSettlementMode() === 'mock' ||
    payment.ledgerSequence != null ||
    verified.confirmed
  ) {
    return finalizeConfirmed({
      row: refreshed,
      feeQuote,
      settlementId: settlement.id,
      payment: {
        transactionHash: payment.transactionHash,
        sourceAccount: payment.innerSourcePublicKey,
        destinationAccount: payment.destinationAccount,
        amount: payment.amount,
        feePayerPublicKey: payment.feePayerPublicKey,
        actualNetworkFeeXlm: payment.actualNetworkFeeXlm,
        actualNetworkFeeStroops: payment.actualNetworkFeeStroops,
        ledgerSequence: payment.ledgerSequence,
      },
    });
  }
  if (String(verified.status || '').toUpperCase().includes('FAIL')) {
    await failTransfer({
      row: refreshed,
      reason: `On-chain failure: ${verified.status}`,
      settlementId: settlement.id,
      feeQuote,
      code: 'STELLAR_CONFIRM_FAILED',
    });
  }
  return refreshed;
}
