/**
 * Increment E — Dayfi → Dayfi internal transfer (ledger-only).
 *
 * Ownership moves between org wallets in one database transaction.
 * No Stellar payment, treasury movement, or provider rail.
 */

import crypto from 'crypto';
import { db } from '../../config/database';
import {
  getOrgBalance,
  InfraLedgerError,
  InfraLedgerTx,
  transferAvailableBalance,
} from './infraLedgerService';
import { formatUsdc, formatXlm, parseUsdcToMinor, parseXlmToMinor } from './infraMoneyAmount';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import {
  assertCustomerCanPay,
  ensureFeeRevenueOrg,
  getTransferSettlementMode,
  isInternalTransferFeeEnabled,
  loadFeeForTransfer,
  quoteDayfiTransactionFee,
  recordTransferFee,
  type DayfiFeeQuote,
  type TransferSettlementMode,
} from './infraFeeService';

export type InfraEnv = 'test' | 'live';

export class InfraTransferError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraTransferError';
    this.code = code;
    this.status = status;
  }
}

type TransferRow = {
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

const TRANSFER_SELECT = `SELECT id::text AS id,
  sender_org_id::text AS sender_org_id,
  recipient_org_id::text AS recipient_org_id,
  environment, amount::text, asset, status,
  sender_transaction_id::text AS sender_transaction_id,
  recipient_transaction_id::text AS recipient_transaction_id,
  sender_movement_id::text AS sender_movement_id,
  recipient_movement_id::text AS recipient_movement_id,
  idempotency_key, request_fingerprint, metadata,
  settlement_mode, fee_id::text AS fee_id, created_at, updated_at
 FROM infra_internal_transfers`;

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

function toNumber(raw: string | number): number {
  return Math.round(Number(raw) * 1e7) / 1e7;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      String((err as { code?: string }).code) === '23505'
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`;
}

function fingerprintPayload(parts: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableJson(parts)).digest('hex');
}

function mapTransfer(
  row: TransferRow,
  extra?: {
    duplicate?: boolean;
    senderBalance?: Awaited<ReturnType<typeof getOrgBalance>>;
    recipientBalance?: Awaited<ReturnType<typeof getOrgBalance>>;
    fee?: DayfiFeeQuote | null;
    settlement?: Record<string, unknown> | null;
    provider?: null;
  }
) {
  const meta = row.metadata || {};
  const fee = extra?.fee ?? ((meta.fee as DayfiFeeQuote | undefined) || null);
  return {
    id: row.id,
    transferGroupId: row.id,
    senderOrgId: row.sender_org_id,
    recipientOrgId: row.recipient_org_id,
    environment: row.environment as InfraEnv,
    amount: toNumber(row.amount),
    asset: row.asset,
    status: row.status,
    settlementMode: (row.settlement_mode ||
      'INTERNAL_LEDGER') as TransferSettlementMode,
    senderTransactionId: row.sender_transaction_id,
    recipientTransactionId: row.recipient_transaction_id,
    senderMovementId: row.sender_movement_id,
    recipientMovementId: row.recipient_movement_id,
    idempotencyKey: row.idempotency_key,
    stellarTouched: Boolean(meta.stellarTouched) === true,
    settlement: extra?.settlement ?? null,
    provider: extra?.provider ?? null,
    fee,
    metadata: meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    duplicate: extra?.duplicate === true,
    senderBalance: extra?.senderBalance,
    recipientBalance: extra?.recipientBalance,
  };
}

async function loadTransfer(id: string): Promise<TransferRow | null> {
  return db.oneOrNone<TransferRow>(`${TRANSFER_SELECT} WHERE id = $1`, [id]);
}

async function loadTransferByIdempotency(
  senderOrgId: string,
  env: InfraEnv,
  idempotencyKey: string
): Promise<TransferRow | null> {
  return db.oneOrNone<TransferRow>(
    `${TRANSFER_SELECT}
     WHERE sender_org_id = $1 AND environment = $2 AND idempotency_key = $3`,
    [senderOrgId, env, idempotencyKey]
  );
}

async function orgExists(orgId: string): Promise<boolean> {
  const row = await db.oneOrNone<{ id: string }>(
    `SELECT id::text AS id FROM infra_organizations WHERE id = $1`,
    [orgId]
  );
  return Boolean(row);
}

async function resolveRecipientOrgId(input: {
  recipientOrgId?: string;
  dayfiTag?: string;
}): Promise<string> {
  const explicit = String(input.recipientOrgId || '').trim();
  if (explicit) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        explicit
      )
    ) {
      throw new InfraTransferError('Unknown recipient', 'UNKNOWN_RECIPIENT', 404);
    }
    if (!(await orgExists(explicit))) {
      throw new InfraTransferError('Unknown recipient', 'UNKNOWN_RECIPIENT', 404);
    }
    return explicit;
  }

  const tag = String(input.dayfiTag || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (!tag) {
    throw new InfraTransferError(
      'recipientOrgId or dayfiTag is required',
      'RECIPIENT_REQUIRED'
    );
  }

  const member = await db.oneOrNone<{ org_id: string | null }>(
    `SELECT org_id::text AS org_id FROM infra_members
     WHERE LOWER(dayfi_tag) = LOWER($1) LIMIT 1`,
    [tag]
  );
  if (!member?.org_id) {
    throw new InfraTransferError('Unknown recipient', 'UNKNOWN_RECIPIENT', 404);
  }
  if (!(await orgExists(member.org_id))) {
    throw new InfraTransferError('Unknown recipient', 'UNKNOWN_RECIPIENT', 404);
  }
  return member.org_id;
}

async function presentTransfer(
  row: TransferRow,
  extra?: {
    duplicate?: boolean;
    senderBalance?: Awaited<ReturnType<typeof getOrgBalance>>;
    recipientBalance?: Awaited<ReturnType<typeof getOrgBalance>>;
  }
) {
  const stored = await loadFeeForTransfer(row.id);
  const metaFee = (row.metadata || {}).fee as DayfiFeeQuote | undefined;
  const fee: DayfiFeeQuote | null = stored
    ? {
        feeAmountUsdc: formatUsdc(parseUsdcToMinor(stored.fee_amount_usdc)),
        feeCurrency: 'USDC',
        feeType: 'DAYFI_TRANSACTION_FEE',
        transferAmount: formatUsdc(parseUsdcToMinor(stored.transfer_amount)),
        customerDebitAmount: formatUsdc(
          parseUsdcToMinor(stored.customer_debit_amount)
        ),
        feeCharged: true,
        feePolicyAmountUsdc: formatUsdc(parseUsdcToMinor(stored.fee_amount_usdc)),
        feeRevenueAmount: formatUsdc(parseUsdcToMinor(stored.fee_revenue_amount)),
        estimatedNetworkFeeAmount:
          ((row.metadata || {}).fee as DayfiFeeQuote | undefined)
            ?.estimatedNetworkFeeAmount || '0.00001',
        estimatedNetworkFeeCurrency: 'XLM',
        actualNetworkFeeAmount: stored.actual_network_fee_amount
          ? formatXlm(parseXlmToMinor(stored.actual_network_fee_amount))
          : null,
        actualNetworkFeeCurrency: 'XLM',
        networkFeePayer: 'DAYFI_XLM_RESERVE',
      }
    : metaFee || null;
  const settlementRow = await db.oneOrNone<{
    id: string;
    status: string;
    external_reference: string | null;
    source_ref: string | null;
    destination_ref: string | null;
    amount: string;
    rail_metadata: Record<string, unknown> | null;
    confirmed_at: Date | null;
  }>(
    `SELECT id::text AS id, status, external_reference, source_ref, destination_ref,
            amount::text, rail_metadata, confirmed_at
     FROM infra_settlements
     WHERE idempotency_key = $1`,
    [`stellar:internal_transfer:${row.id}`]
  );
  const meta = settlementRow?.rail_metadata || {};
  const settlement =
    row.settlement_mode === 'STELLAR_ONCHAIN' && settlementRow
      ? {
          id: settlementRow.id,
          status: settlementRow.status,
          stellarTransactionHash: settlementRow.external_reference,
          sourcePublicKey: settlementRow.source_ref || meta.usdcSource || null,
          destinationPublicKey: settlementRow.destination_ref || null,
          usdcAmount: settlementRow.amount,
          usdcIssuer: resolveUsdcIssuer(true),
          feePayerPublicKey: meta.feePayerPublicKey || null,
          actualNetworkFeeXlm: meta.actualNetworkFeeXlm || null,
          settlementStatus: settlementRow.status,
          confirmedAt: settlementRow.confirmed_at,
        }
      : null;
  return mapTransfer(row, { ...extra, fee, settlement, provider: null });
}

export async function getInternalTransfer(input: {
  orgId: string;
  transferId: string;
}) {
  const row = await loadTransfer(input.transferId);
  if (!row) {
    throw new InfraTransferError('Transfer not found', 'NOT_FOUND', 404);
  }
  if (row.sender_org_id !== input.orgId && row.recipient_org_id !== input.orgId) {
    throw new InfraTransferError('Transfer not found', 'NOT_FOUND', 404);
  }
  return presentTransfer(row);
}

export async function createInternalTransfer(input: {
  senderOrgId: string;
  environment: InfraEnv | string;
  amount: number | string;
  recipientOrgId?: string;
  recipientEnvironment?: string;
  dayfiTag?: string;
  idempotencyKey?: string;
  reason?: string;
  asset?: string;
  settlementMode?: string;
}): Promise<ReturnType<typeof mapTransfer>> {
  const env = asEnv(String(input.environment || 'test'));
  const transferMinor = parseUsdcToMinor(input.amount);
  if (transferMinor <= BigInt(0)) {
    throw new InfraTransferError('Amount must be a positive number', 'INVALID_AMOUNT');
  }
  const amount = formatUsdc(transferMinor);
  const asset = String(input.asset || 'USDC').trim().toUpperCase() || 'USDC';
  if (asset !== 'USDC') {
    throw new InfraTransferError('Increment E only transfers USDC', 'UNSUPPORTED_ASSET');
  }

  if (input.recipientEnvironment && asEnv(input.recipientEnvironment) !== env) {
    throw new InfraTransferError(
      'Cross-environment transfers are not allowed',
      'CROSS_ENVIRONMENT',
      400
    );
  }

  const recipientOrgId = await resolveRecipientOrgId({
    recipientOrgId: input.recipientOrgId,
    dayfiTag: input.dayfiTag,
  });

  if (recipientOrgId === input.senderOrgId) {
    throw new InfraTransferError(
      'Cannot transfer to the same organization',
      'SELF_TRANSFER',
      400
    );
  }

  const settlementMode = getTransferSettlementMode(input.settlementMode);
  const feeQuote = quoteDayfiTransactionFee({
    transferAmount: amount,
    chargeFee:
      settlementMode === 'INTERNAL_LEDGER' && isInternalTransferFeeEnabled(),
  });

  if (settlementMode === 'STELLAR_ONCHAIN') {
    const fingerprint = fingerprintPayload({
      amount,
      asset,
      env,
      recipientOrgId,
      settlementMode,
    });
    const idem = String(input.idempotencyKey || '').trim() || null;
    if (env === 'live' && !idem) {
      throw new InfraTransferError(
        'Idempotency-Key is required for LIVE',
        'IDEMPOTENCY_REQUIRED',
        400
      );
    }
    if (idem) {
      const existing = await loadTransferByIdempotency(input.senderOrgId, env, idem);
      if (
        existing?.request_fingerprint &&
        existing.request_fingerprint !== fingerprint
      ) {
        throw new InfraTransferError(
          'Idempotency-Key reused with different parameters',
          'IDEMPOTENCY_CONFLICT',
          409
        );
      }
      if (existing && (existing.status === 'completed' || existing.status === 'failed')) {
        const [senderBalance, recipientBalance] = await Promise.all([
          getOrgBalance(existing.sender_org_id, existing.environment),
          getOrgBalance(existing.recipient_org_id, existing.environment),
        ]);
        return presentTransfer(existing, {
          duplicate: true,
          senderBalance,
          recipientBalance,
        });
      }
    }
    const { executeOnchainInternalTransfer } = await import(
      './infraOnchainTransferService'
    );
    const completed = await executeOnchainInternalTransfer({
      senderOrgId: input.senderOrgId,
      recipientOrgId,
      environment: env,
      amount,
      idempotencyKey: idem,
      fingerprint,
      reason: input.reason,
    });
    const [senderBalance, recipientBalance] = await Promise.all([
      getOrgBalance(completed.sender_org_id, completed.environment),
      getOrgBalance(completed.recipient_org_id, completed.environment),
    ]);
    return presentTransfer(completed, { senderBalance, recipientBalance });
  }

  if (feeQuote.feeCharged) {
    await ensureFeeRevenueOrg();
    const senderBal = await getOrgBalance(input.senderOrgId, env);
    assertCustomerCanPay({
      availableUsdc: senderBal.available,
      transferAmount: feeQuote.transferAmount,
      feeAmountUsdc: feeQuote.feeAmountUsdc,
    });
  }

  const idem =
    String(input.idempotencyKey || '').trim() || null;
  if (env === 'live' && !idem) {
    throw new InfraTransferError(
      'Idempotency-Key is required for LIVE',
      'IDEMPOTENCY_REQUIRED',
      400
    );
  }

  const fingerprint = fingerprintPayload({
    amount,
    asset,
    env,
    recipientOrgId,
    settlementMode,
  });

  if (idem) {
    const existing = await loadTransferByIdempotency(input.senderOrgId, env, idem);
    if (existing) {
      if (
        existing.request_fingerprint &&
        existing.request_fingerprint !== fingerprint
      ) {
        throw new InfraTransferError(
          'Idempotency-Key reused with different parameters',
          'IDEMPOTENCY_CONFLICT',
          409
        );
      }
      const [senderBalance, recipientBalance] = await Promise.all([
        getOrgBalance(existing.sender_org_id, existing.environment),
        getOrgBalance(existing.recipient_org_id, existing.environment),
      ]);
      return presentTransfer(existing, {
        duplicate: true,
        senderBalance,
        recipientBalance,
      });
    }
  }

  const transferGroupId = crypto.randomUUID();
  const debitKey = idem
    ? `internal_transfer:${idem}:debit`
    : `internal_transfer:${transferGroupId}:debit`;
  const creditKey = idem
    ? `internal_transfer:${idem}:credit`
    : `internal_transfer:${transferGroupId}:credit`;
  const feeIdem = `transfer:${idem || transferGroupId}:fee`;

  const returning = `id::text AS id,
           sender_org_id::text AS sender_org_id,
           recipient_org_id::text AS recipient_org_id,
           environment, amount::text, asset, status,
           sender_transaction_id::text AS sender_transaction_id,
           recipient_transaction_id::text AS recipient_transaction_id,
           sender_movement_id::text AS sender_movement_id,
           recipient_movement_id::text AS recipient_movement_id,
           idempotency_key, request_fingerprint, metadata,
           settlement_mode, fee_id::text AS fee_id, created_at, updated_at`;

  try {
    const completed = await db.tx(async (t) => {
      const tx = t as unknown as InfraLedgerTx;
      const transfer = await tx.one<TransferRow>(
        `INSERT INTO infra_internal_transfers
           (id, sender_org_id, recipient_org_id, environment, amount, asset, status,
            idempotency_key, request_fingerprint, metadata, settlement_mode)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $8, $9::jsonb, $10)
         RETURNING ${returning}`,
        [
          transferGroupId,
          input.senderOrgId,
          recipientOrgId,
          env,
          amount,
          asset,
          idem,
          fingerprint,
          JSON.stringify({
            type: 'internal_transfer',
            reason: input.reason || null,
            stellarTouched: false,
            settlementMode,
            fee: feeQuote,
          }),
          settlementMode,
        ]
      );

      const sharedTxMeta = {
        type: 'internal_transfer',
        transferGroupId: transfer.id,
        usdcAmount: amount,
        rail: 'internal_transfer',
        stellarTouched: false,
        provider: null,
        settlementRail: 'NONE',
        settlementMode,
        fee: feeQuote,
      };

      const senderTx = await tx.one<{ id: string }>(
        `INSERT INTO infra_transactions
           (org_id, environment, amount, currency, status, method, direction, fee,
            external_id, metadata, client_idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, 'USDC', 'completed', 'internal_transfer', 'internal_transfer',
                 $8, $4, $5::jsonb, $6, $7)
         RETURNING id::text AS id`,
        [
          input.senderOrgId,
          env,
          amount,
          `internal-transfer:${transfer.id}:out`,
          JSON.stringify({
            ...sharedTxMeta,
            role: 'sender',
            counterpartyOrgId: recipientOrgId,
          }),
          idem ? `${idem}:out` : null,
          fingerprint,
          feeQuote.feeCharged ? feeQuote.feeAmountUsdc : 0,
        ]
      );

      const recipientTx = await tx.one<{ id: string }>(
        `INSERT INTO infra_transactions
           (org_id, environment, amount, currency, status, method, direction, fee,
            external_id, metadata, client_idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, 'USDC', 'completed', 'internal_transfer', 'internal_transfer',
                 0, $4, $5::jsonb, $6, $7)
         RETURNING id::text AS id`,
        [
          recipientOrgId,
          env,
          amount,
          `internal-transfer:${transfer.id}:in`,
          JSON.stringify({
            ...sharedTxMeta,
            role: 'recipient',
            counterpartyOrgId: input.senderOrgId,
          }),
          idem ? `${idem}:in` : null,
          fingerprint,
        ]
      );

      const ledger = await transferAvailableBalance({
        senderOrgId: input.senderOrgId,
        recipientOrgId,
        environment: env,
        amount,
        asset,
        transferGroupId: transfer.id,
        debitIdempotencyKey: debitKey,
        creditIdempotencyKey: creditKey,
        senderReferenceId: senderTx.id,
        recipientReferenceId: recipientTx.id,
        metadata: { reason: input.reason || null, settlementMode },
        t: tx,
      });

      const recordedFee = await recordTransferFee({
        t: tx,
        payerOrgId: input.senderOrgId,
        environment: env,
        transferGroupId: transfer.id,
        senderTransactionId: senderTx.id,
        quote: feeQuote,
        settlementMode,
        idempotencyKey: feeIdem,
      });

      const updated = await tx.one<TransferRow>(
        `UPDATE infra_internal_transfers SET
           sender_transaction_id = $2,
           recipient_transaction_id = $3,
           sender_movement_id = $4,
           recipient_movement_id = $5,
           fee_id = $6,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING ${returning}`,
        [
          transfer.id,
          senderTx.id,
          recipientTx.id,
          ledger.debit.id,
          ledger.credit.id,
          recordedFee?.feeId || null,
        ]
      );

      return updated;
    });

    const [senderBalance, recipientBalance] = await Promise.all([
      getOrgBalance(completed.sender_org_id, completed.environment),
      getOrgBalance(completed.recipient_org_id, completed.environment),
    ]);
    return presentTransfer(completed, { senderBalance, recipientBalance });
  } catch (err: unknown) {
    if (
      err instanceof InfraTransferError ||
      err instanceof InfraLedgerError
    ) {
      throw err;
    }
    if (isUniqueViolation(err) && idem) {
      const existing = await loadTransferByIdempotency(input.senderOrgId, env, idem);
      if (existing) {
        if (
          existing.request_fingerprint &&
          existing.request_fingerprint !== fingerprint
        ) {
          throw new InfraTransferError(
            'Idempotency-Key reused with different parameters',
            'IDEMPOTENCY_CONFLICT',
            409
          );
        }
        const [senderBalance, recipientBalance] = await Promise.all([
          getOrgBalance(existing.sender_org_id, existing.environment),
          getOrgBalance(existing.recipient_org_id, existing.environment),
        ]);
        return presentTransfer(existing, {
          duplicate: true,
          senderBalance,
          recipientBalance,
        });
      }
    }
    throw err;
  }
}
