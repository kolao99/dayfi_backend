/**
 * Phase 5 — Settlement domain (rail-agnostic).
 *
 * Dayfi ledger remains the financial source of truth.
 * Settlement = external proof linked to a Phase 2 payout.
 * Bulk never calls this — only child payouts do.
 */

import { db } from '../../config/database';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import {
  finalizePayoutDebit,
  releasePayoutLock,
} from './infraLifecycleService';
import { resolveDestinationForPayout } from './infraRecipientService';
import {
  getOrgStellarAccount,
  getOrgStellarSigningSecret,
  InfraStellarAccountError,
} from './infraStellarAccountService';
import {
  getStellarSettlementMode,
  submitUsdcPayment,
  verifyUsdcPayment,
  StellarSettlementAdapterError,
} from './stellarSettlementAdapter';
import StellarSdk from '@stellar/stellar-sdk';

export type InfraEnv = 'test' | 'live';
export type InfraStellarPayoutMode = 'off' | 'mock' | 'live';
export type SettlementStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export class InfraSettlementError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraSettlementError';
    this.code = code;
    this.status = status;
  }
}

type SettlementRow = {
  id: string;
  org_id: string;
  environment: string;
  payout_transaction_id: string;
  rail: string;
  asset: string;
  amount: string;
  source_ref: string | null;
  destination_ref: string | null;
  status: string;
  external_reference: string | null;
  provider_reference: string | null;
  rail_metadata: Record<string, unknown>;
  failure_reason: string | null;
  idempotency_key: string;
  submitted_at: Date | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type TxRow = {
  id: string;
  org_id: string;
  environment: string;
  amount: string;
  currency: string;
  status: string;
  method: string;
  direction: string;
  metadata: Record<string, unknown> | null;
};

const SETTLEMENT_SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment,
  payout_transaction_id::text AS payout_transaction_id, rail, asset, amount::text,
  source_ref, destination_ref, status, external_reference, provider_reference,
  rail_metadata, failure_reason, idempotency_key, submitted_at, confirmed_at,
  created_at, updated_at
 FROM infra_settlements`;

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

export function getInfraStellarPayoutMode(): InfraStellarPayoutMode {
  const raw = String(process.env.DAYFI_INFRA_STELLAR_PAYOUT_MODE || 'off')
    .trim()
    .toLowerCase();
  if (raw === 'mock' || raw === 'live' || raw === 'off') return raw;
  return 'off';
}

function assertStellarAddress(addr: string, label: string): string {
  const a = String(addr || '').trim();
  if (!/^G[A-Z0-9]{55}$/.test(a)) {
    throw new InfraSettlementError(
      `Invalid Stellar ${label} address`,
      'INVALID_ADDRESS',
      400
    );
  }
  return a;
}

async function orgWalletUsdcBalance(publicKey: string): Promise<number> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const issuer = resolveUsdcIssuer(cfg.isTestnet);
    const row = (
      account.balances as { asset_code?: string; asset_issuer?: string; balance?: string }[]
    ).find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    return parseFloat(String(row?.balance || '0')) || 0;
  } catch {
    return 0;
  }
}

async function resolvePayoutSigning(input: {
  orgId: string;
  environment: InfraEnv;
  explicitSecret?: string;
  usdcAmount: number;
}): Promise<{ secret: string; publicKey: string; source: 'org_wallet' | 'treasury' }> {
  if (input.explicitSecret?.trim()) {
    const kp = StellarSdk.Keypair.fromSecret(input.explicitSecret.trim());
    return {
      secret: input.explicitSecret.trim(),
      publicKey: kp.publicKey(),
      source: 'org_wallet',
    };
  }

  const mode = getInfraStellarPayoutMode();
  if (mode === 'off') {
    return {
      secret: '',
      publicKey: '',
      source: 'treasury',
    };
  }

  const cfg = getStellarConfig();
  if (mode === 'live' && !cfg.isTestnet) {
    throw new InfraSettlementError(
      'Org wallet payout live mode is Testnet-only in Increment F',
      'MAINNET_BLOCKED',
      400
    );
  }

  try {
    const signing = await getOrgStellarSigningSecret(input.orgId, input.environment);
    if (mode === 'live') {
      const onChain = await orgWalletUsdcBalance(signing.publicKey);
      if (onChain + 1e-7 < input.usdcAmount) {
        throw new InfraSettlementError(
          `Org Stellar wallet USDC (${onChain}) insufficient for ${input.usdcAmount}`,
          'INSUFFICIENT_ONCHAIN_BALANCE',
          409
        );
      }
    }
    return {
      secret: signing.secret,
      publicKey: signing.publicKey,
      source: 'org_wallet',
    };
  } catch (err: unknown) {
    if (err instanceof InfraSettlementError) throw err;
    const message =
      err instanceof InfraStellarAccountError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new InfraSettlementError(message, 'ORG_WALLET_UNAVAILABLE', 409);
  }
}

function num(v: string | number | null | undefined): number {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function mapSettlement(row: SettlementRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment,
    payoutTransactionId: row.payout_transaction_id,
    rail: row.rail,
    asset: row.asset,
    amount: num(row.amount),
    sourceRef: row.source_ref,
    destinationRef: row.destination_ref,
    status: row.status as SettlementStatus,
    externalReference: row.external_reference,
    providerReference: row.provider_reference,
    railMetadata: row.rail_metadata || {},
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadSettlement(orgId: string, settlementId: string): Promise<SettlementRow> {
  const row = await db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE id = $1 AND org_id = $2`,
    [settlementId, orgId]
  );
  if (!row) throw new InfraSettlementError('Settlement not found', 'NOT_FOUND', 404);
  return row;
}

async function loadPayout(orgId: string, payoutId: string): Promise<TxRow> {
  const row = await db.oneOrNone<TxRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, amount::text, currency,
            status, method, direction, metadata
     FROM infra_transactions
     WHERE id = $1 AND org_id = $2 AND direction = 'payout'`,
    [payoutId, orgId]
  );
  if (!row) throw new InfraSettlementError('Payout not found', 'PAYOUT_NOT_FOUND', 404);
  return row;
}

export async function getSettlement(orgId: string, settlementId: string) {
  return mapSettlement(await loadSettlement(orgId, settlementId));
}

export async function getSettlementForPayout(orgId: string, payoutId: string) {
  const row = await db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT}
     WHERE org_id = $1 AND payout_transaction_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, payoutId]
  );
  return row ? mapSettlement(row) : null;
}

export async function listSettlements(
  orgId: string,
  environment: InfraEnv | string,
  opts?: { limit?: number }
) {
  const env = asEnv(String(environment));
  const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 100);
  const rows = await db.manyOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT}
     WHERE org_id = $1 AND environment = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [orgId, env, limit]
  );
  return rows.map(mapSettlement);
}

async function resolvePayoutDestination(payout: TxRow): Promise<{
  destination: string;
  asset: string;
  network: string;
}> {
  const meta = payout.metadata || {};
  const saved = (meta.savedRecipient || {}) as Record<string, unknown>;
  const recipient = (meta.recipient || {}) as Record<string, unknown>;

  if (saved.recipientId) {
    const resolved = await resolveDestinationForPayout({
      orgId: payout.org_id,
      environment: payout.environment,
      recipientId: String(saved.recipientId),
      destinationId: saved.destinationId
        ? String(saved.destinationId)
        : undefined,
    });
    const data = resolved.destination.destinationData || {};
    const addr = String(data.walletAddress || data.accountNumber || '').trim();
    if (!addr) {
      throw new InfraSettlementError(
        'Recipient destination has no wallet address',
        'NO_DESTINATION'
      );
    }
    return {
      destination: addr,
      asset: String(data.asset || payout.currency || 'USDC').toUpperCase(),
      network: String(data.network || recipient.network || 'stellar').toLowerCase(),
    };
  }

  const addr = String(recipient.walletAddress || '').trim();
  if (!addr) {
    throw new InfraSettlementError(
      'Payout has no Stellar destination wallet',
      'NO_DESTINATION'
    );
  }
  return {
    destination: addr,
    asset: String(recipient.asset || payout.currency || 'USDC').toUpperCase(),
    network: String(recipient.network || 'stellar').toLowerCase(),
  };
}

async function confirmAndFinalize(
  orgId: string,
  settlement: SettlementRow,
  opts?: { ledgerSequence?: number | null; transactionHash?: string | null }
) {
  const hash =
    opts?.transactionHash ||
    settlement.external_reference ||
    null;

  await db.none(
    `UPDATE infra_settlements SET
       status = 'confirmed',
       external_reference = COALESCE($2, external_reference),
       provider_reference = COALESCE($2, provider_reference),
       confirmed_at = CURRENT_TIMESTAMP,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $3::jsonb,
       failure_reason = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      settlement.id,
      hash,
      JSON.stringify({
        confirmedLedgerSequence: opts?.ledgerSequence ?? null,
        confirmedAt: new Date().toISOString(),
      }),
    ]
  );

  await finalizePayoutDebit({
    orgId,
    transactionId: settlement.payout_transaction_id,
    providerEventId: `stellar:ok:${hash || settlement.id}`,
    source: 'stellar_settlement',
  });

  await db.none(
    `UPDATE infra_transactions SET
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [
      settlement.payout_transaction_id,
      JSON.stringify({
        settlementId: settlement.id,
        stellarTransactionHash: hash,
        settlementRail: 'STELLAR',
      }),
    ]
  );

  return {
    settlement: mapSettlement(await loadSettlement(orgId, settlement.id)),
    payoutId: settlement.payout_transaction_id,
  };
}

/**
 * Settle a locked crypto/Stellar payout end-to-end:
 * Settlement row → Stellar USDC payment → confirm → finalize Dayfi debit.
 * On submit failure: settlement=failed + release lock.
 */
export async function settlePayoutOnStellar(input: {
  orgId: string;
  payoutTransactionId: string;
  sourceSecret?: string;
}) {
  const payout = await loadPayout(input.orgId, input.payoutTransactionId);
  const env = asEnv(payout.environment);
  const meta = payout.metadata || {};

  if (payout.method !== 'crypto') {
    throw new InfraSettlementError(
      'Only crypto payouts can settle on Stellar in Phase 5',
      'UNSUPPORTED_METHOD'
    );
  }
  // Prefer ledgerLockId as proof of lock; fundsLocked alone can be response-only.
  const locked =
    Boolean(meta.ledgerLockId) ||
    meta.fundsLocked === true ||
    (typeof meta.usdcAmount === 'number' &&
      meta.usdcAmount > 0 &&
      !meta.fundsReleased &&
      !meta.fundsFinalized);
  if (!locked) {
    throw new InfraSettlementError(
      'Payout funds are not locked',
      'NOT_LOCKED'
    );
  }
  if (meta.fundsFinalized) {
    const existing = await getSettlementForPayout(input.orgId, payout.id);
    if (existing?.status === 'confirmed') {
      return { settlement: existing, payoutId: payout.id };
    }
    throw new InfraSettlementError('Payout already finalized', 'ALREADY_FINALIZED');
  }

  const dest = await resolvePayoutDestination(payout);
  if (dest.network !== 'stellar') {
    throw new InfraSettlementError(
      `Unsupported network for Stellar settlement: ${dest.network}`,
      'UNSUPPORTED_NETWORK'
    );
  }
  if (dest.asset !== 'USDC') {
    throw new InfraSettlementError(
      `Phase 5 only settles USDC (got ${dest.asset})`,
      'UNSUPPORTED_ASSET'
    );
  }

  const destination = assertStellarAddress(dest.destination, 'destination');
  const orgWallet = await getOrgStellarAccount(input.orgId, env);
  if (
    getInfraStellarPayoutMode() !== 'off' &&
    orgWallet &&
    destination === orgWallet.publicKey
  ) {
    throw new InfraSettlementError(
      'Cannot send to the organization own Stellar wallet',
      'SELF_TRANSFER',
      400
    );
  }

  const usdcAmount = num((meta.usdcAmount as number) ?? payout.amount);
  if (usdcAmount <= 0) {
    throw new InfraSettlementError('Invalid USDC amount', 'INVALID_AMOUNT');
  }

  const idempotencyKey = `stellar:payout:${payout.id}`;

  let settlement = await db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE org_id = $1 AND idempotency_key = $2`,
    [input.orgId, idempotencyKey]
  );

  if (settlement?.status === 'confirmed') {
    return { settlement: mapSettlement(settlement), payoutId: payout.id };
  }

  if (settlement?.status === 'submitted' && settlement.external_reference) {
    const verified = await verifyUsdcPayment(settlement.external_reference);
    if (verified.confirmed) {
      return confirmAndFinalize(input.orgId, settlement, {
        ledgerSequence: verified.ledgerSequence,
        transactionHash: settlement.external_reference,
      });
    }
  }

  if (!settlement) {
    settlement = await db.one<SettlementRow>(
      `INSERT INTO infra_settlements
         (org_id, environment, payout_transaction_id, rail, asset, amount,
          destination_ref, status, idempotency_key, rail_metadata)
       VALUES ($1, $2, $3, 'STELLAR', 'USDC', $4, $5, 'pending', $6, $7::jsonb)
       RETURNING id::text AS id, org_id::text AS org_id, environment,
                 payout_transaction_id::text AS payout_transaction_id, rail, asset, amount::text,
                 source_ref, destination_ref, status, external_reference, provider_reference,
                 rail_metadata, failure_reason, idempotency_key, submitted_at, confirmed_at,
                 created_at, updated_at`,
      [
        input.orgId,
        env,
        payout.id,
        usdcAmount,
        destination,
        idempotencyKey,
        JSON.stringify({
          adapterMode: getStellarSettlementMode(),
          payoutMode: getInfraStellarPayoutMode(),
          network: dest.network,
        }),
      ]
    );
  }

  const signing = await resolvePayoutSigning({
    orgId: input.orgId,
    environment: env,
    explicitSecret: input.sourceSecret,
    usdcAmount,
  });

  let payment;
  try {
    payment = await submitUsdcPayment({
      destination,
      amount: usdcAmount,
      memo: `dayfi:${String(payout.id).replace(/-/g, '').slice(0, 24)}`,
      sourceSecret: signing.source === 'org_wallet' ? signing.secret : input.sourceSecret,
    });
  } catch (err: any) {
    const reason =
      err instanceof StellarSettlementAdapterError
        ? err.message
        : err?.message || 'Stellar submit failed';

    await db.none(
      `UPDATE infra_settlements SET
         status = 'failed',
         failure_reason = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [settlement!.id, reason]
    );

    await releasePayoutLock({
      orgId: input.orgId,
      transactionId: payout.id,
      providerEventId: `stellar:fail:${settlement!.id}`,
      source: 'stellar_settlement',
      status: 'failed',
    });

    throw new InfraSettlementError(reason, 'STELLAR_SUBMIT_FAILED', 502);
  }

  await db.none(
    `UPDATE infra_settlements SET
       status = 'submitted',
       source_ref = $2,
       destination_ref = $3,
       external_reference = $4,
       provider_reference = $4,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $5::jsonb,
       submitted_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      settlement!.id,
      payment.sourceAccount,
      payment.destinationAccount,
      payment.transactionHash,
      JSON.stringify({
        stellar: {
          transactionHash: payment.transactionHash,
          ledgerSequence: payment.ledgerSequence,
          operationId: payment.operationId,
          networkPassphrase: payment.networkPassphrase,
          rpcUrl: payment.rpcUrl,
          mode: payment.mode,
          amount: payment.amount,
        },
        signingSource: signing.source,
        orgWalletPublicKey: signing.publicKey || payment.sourceAccount,
      }),
    ]
  );

  settlement = await loadSettlement(input.orgId, settlement!.id);

  const shouldConfirm =
    payment.mode === 'mock' ||
    payment.ledgerSequence != null ||
    String(payment.raw?.finalStatus || '')
      .toUpperCase()
      .includes('SUCCESS');

  if (shouldConfirm) {
    return confirmAndFinalize(input.orgId, settlement, {
      ledgerSequence: payment.ledgerSequence,
      transactionHash: payment.transactionHash,
    });
  }

  const verified = await verifyUsdcPayment(payment.transactionHash);
  if (verified.confirmed) {
    return confirmAndFinalize(input.orgId, settlement, {
      ledgerSequence: verified.ledgerSequence,
      transactionHash: payment.transactionHash,
    });
  }
  if (
    String(verified.status || '').toUpperCase().includes('FAIL') ||
    verified.status === 'FAILED'
  ) {
    await db.none(
      `UPDATE infra_settlements SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [settlement.id, `On-chain failure: ${verified.status}`]
    );
    await releasePayoutLock({
      orgId: input.orgId,
      transactionId: payout.id,
      providerEventId: `stellar:chain-fail:${settlement.id}`,
      source: 'stellar_settlement',
      status: 'failed',
    });
    throw new InfraSettlementError(
      'Stellar transaction failed on-chain',
      'TX_FAILED',
      502
    );
  }

  return {
    settlement: mapSettlement(settlement),
    payoutId: payout.id,
    pendingConfirmation: true as const,
  };
}

/** Re-verify a submitted Stellar settlement and finalize if on-chain success. */
export async function confirmStellarSettlement(
  orgId: string,
  settlementId: string
) {
  const row = await loadSettlement(orgId, settlementId);
  if (row.rail !== 'STELLAR') {
    throw new InfraSettlementError('Not a Stellar settlement', 'WRONG_RAIL');
  }
  if (row.status === 'confirmed') {
    return {
      settlement: mapSettlement(row),
      payoutId: row.payout_transaction_id,
    };
  }
  if (!row.external_reference) {
    throw new InfraSettlementError(
      'No external reference to verify',
      'NO_EXTERNAL_REF'
    );
  }

  const verified = await verifyUsdcPayment(row.external_reference);
  if (!verified.confirmed) {
    if (
      String(verified.status || '').toUpperCase().includes('FAIL') ||
      verified.status === 'FAILED'
    ) {
      await db.none(
        `UPDATE infra_settlements SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [row.id, `On-chain failure: ${verified.status}`]
      );
      await releasePayoutLock({
        orgId,
        transactionId: row.payout_transaction_id,
        providerEventId: `stellar:chain-fail:${row.id}`,
        source: 'stellar_settlement',
        status: 'failed',
      });
      throw new InfraSettlementError(
        'Stellar transaction failed on-chain',
        'TX_FAILED',
        502
      );
    }
    throw new InfraSettlementError(
      `Settlement not confirmed on-chain (status=${verified.status})`,
      'NOT_CONFIRMED',
      409
    );
  }

  return confirmAndFinalize(orgId, row, {
    ledgerSequence: verified.ledgerSequence,
    transactionHash: row.external_reference,
  });
}
