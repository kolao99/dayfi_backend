/**
 * Increment C — TESTNET collection wallet funding.
 *
 * After verified collection ledger credit:
 *   Provider confirmation → ledger credit → treasury → org Stellar wallet (real TX when live)
 *
 * Modes (DAYFI_INFRA_STELLAR_FUNDING_MODE):
 *   off  — default; no on-chain funding (Phases 1–8 unchanged)
 *   mock — deterministic adapter hash for CI
 *   live — real Testnet USDC from DAYFI_STELLAR_SETTLEMENT_SECRET treasury
 *
 * Never fabricates hashes. Insufficient treasury → pending_treasury (ledger credit stands).
 */

import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import { releasePendingToAvailable } from './infraLedgerService';
import {
  getOrgStellarAccount,
  provisionOrgStellarAccount,
  InfraStellarAccountError,
} from './infraStellarAccountService';
import {
  getStellarSettlementMode,
  submitUsdcPayment,
  verifyUsdcPayment,
  StellarSettlementAdapterError,
} from './stellarSettlementAdapter';
import type { InfraEnvironment } from './infraLedgerService';

export type InfraStellarFundingMode = 'off' | 'mock' | 'live';
export type CollectionFundingStatus =
  | 'skipped'
  | 'pending_treasury'
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed';

export class InfraStellarFundingError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraStellarFundingError';
    this.code = code;
    this.status = status;
  }
}

type SettlementRow = {
  id: string;
  org_id: string;
  environment: string;
  collection_transaction_id: string | null;
  rail: string;
  asset: string;
  amount: string;
  source_ref: string | null;
  destination_ref: string | null;
  status: string;
  external_reference: string | null;
  idempotency_key: string;
  rail_metadata: Record<string, unknown>;
  failure_reason: string | null;
};

const SETTLEMENT_SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment,
  collection_transaction_id::text AS collection_transaction_id, rail, asset, amount::text,
  source_ref, destination_ref, status, external_reference, idempotency_key,
  rail_metadata, failure_reason
 FROM infra_settlements`;

export function getInfraStellarFundingMode(): InfraStellarFundingMode {
  const raw = String(process.env.DAYFI_INFRA_STELLAR_FUNDING_MODE || 'off')
    .trim()
    .toLowerCase();
  if (raw === 'mock' || raw === 'live' || raw === 'off') return raw;
  return 'off';
}

function treasurySecret(): string | null {
  const secret =
    process.env.DAYFI_STELLAR_SETTLEMENT_SECRET?.trim() ||
    process.env.MASTER_WALLET_SECRET_KEY?.trim() ||
    '';
  return secret || null;
}

/** Dayfi treasury / master Stellar public key (never a secret). */
export function getDayfiTreasuryPublicKey(): string | null {
  return treasuryPublicKey();
}

function treasuryPublicKey(): string | null {
  const settlementSecret = process.env.DAYFI_STELLAR_SETTLEMENT_SECRET?.trim();
  if (settlementSecret) {
    try {
      return StellarSdk.Keypair.fromSecret(settlementSecret).publicKey();
    } catch {
      return null;
    }
  }
  const fromEnv = process.env.MASTER_WALLET_PUBLIC_KEY?.trim();
  if (fromEnv) return fromEnv;
  const secret = treasurySecret();
  if (!secret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}

async function treasuryUsdcBalance(): Promise<number | null> {
  const obs = await observeDayfiTreasuryOnChain();
  return obs?.usdc ?? null;
}

/**
 * Increment G — read-only Horizon observation of Dayfi treasury liquidity.
 * Never trusts a DB cache as the source of truth for on-chain USDC/XLM.
 * In mock settlement mode, uses DAYFI_TREASURY_MOCK_USDC / _XLM (no Horizon).
 */
export async function observeDayfiTreasuryOnChain(): Promise<{
  publicKey: string;
  network: string;
  isTestnet: boolean;
  usdcIssuer: string;
  usdc: number;
  xlm: number;
  horizonLedger: number | null;
  observedAt: string;
} | null> {
  const cfg = getStellarConfig();
  const pk = treasuryPublicKey();
  if (!pk) return null;
  const issuer = resolveUsdcIssuer(cfg.isTestnet);
  const observedAt = new Date().toISOString();

  if (getStellarSettlementMode() === 'mock') {
    const usdc = Number(process.env.DAYFI_TREASURY_MOCK_USDC || '0');
    const xlm = Number(process.env.DAYFI_TREASURY_MOCK_XLM || '100');
    return {
      publicKey: pk,
      network: cfg.isTestnet ? 'testnet' : 'public',
      isTestnet: cfg.isTestnet,
      usdcIssuer: issuer,
      usdc: Number.isFinite(usdc) ? usdc : 0,
      xlm: Number.isFinite(xlm) ? xlm : 0,
      horizonLedger: null,
      observedAt,
    };
  }

  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(pk);
    const balances = account.balances as {
      asset_code?: string;
      asset_issuer?: string;
      asset_type?: string;
      balance?: string;
    }[];
    const usdcRow = balances.find(
      (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer
    );
    const native = balances.find((b) => b.asset_type === 'native');
    const usdc = parseFloat(String(usdcRow?.balance || '0'));
    const xlm = parseFloat(String(native?.balance || '0'));
    return {
      publicKey: pk,
      network: cfg.isTestnet ? 'testnet' : 'public',
      isTestnet: cfg.isTestnet,
      usdcIssuer: issuer,
      usdc: Number.isFinite(usdc) ? usdc : 0,
      xlm: Number.isFinite(xlm) ? xlm : 0,
      horizonLedger: (account as { sequence?: string }).sequence
        ? Number((account as { sequence?: string }).sequence)
        : null,
      observedAt,
    };
  } catch {
    return null;
  }
}

function mapFundingSettlement(row: SettlementRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    collectionTransactionId: row.collection_transaction_id,
    rail: row.rail,
    asset: row.asset,
    amount: Number(row.amount),
    sourceRef: row.source_ref,
    destinationRef: row.destination_ref,
    status: row.status,
    externalReference: row.external_reference,
    idempotencyKey: row.idempotency_key,
    railMetadata: row.rail_metadata || {},
    failureReason: row.failure_reason,
  };
}

async function patchCollectionFundingMeta(
  collectionId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await db.none(
    `UPDATE infra_transactions
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [collectionId, JSON.stringify({ walletFunding: patch })]
  );
}

async function confirmCollectionFunding(
  settlement: SettlementRow,
  opts: { hash: string | null; ledgerSequence?: number | null }
) {
  const hash = opts.hash || settlement.external_reference;
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
        purpose: 'collection_wallet_funding',
        confirmedAt: new Date().toISOString(),
        confirmedLedgerSequence: opts.ledgerSequence ?? null,
      }),
    ]
  );

  const updated = await db.one<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE id = $1`,
    [settlement.id]
  );

  await patchCollectionFundingMeta(settlement.collection_transaction_id!, {
    mode: getInfraStellarFundingMode(),
    status: 'confirmed',
    settlementId: settlement.id,
    stellarTransactionHash: hash,
    sourceAccount: settlement.source_ref || treasuryPublicKey(),
    destinationAccount: settlement.destination_ref,
    amount: Number(settlement.amount),
    asset: 'USDC',
    confirmedAt: new Date().toISOString(),
  });

  const collectionId = settlement.collection_transaction_id!;
  await releasePendingToAvailable({
    orgId: settlement.org_id,
    environment: settlement.environment,
    amount: Number(settlement.amount),
    idempotencyKey: `collection:${collectionId}:available`,
    movementType: 'collection_credit',
    referenceType: 'collection',
    referenceId: collectionId,
    reference: collectionId,
    metadata: {
      stellarTransactionHash: hash,
      settlementId: settlement.id,
      ledgerPhase: 'available',
    },
  });

  await db.none(
    `UPDATE infra_transactions SET
       status = 'settled',
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [
      collectionId,
      JSON.stringify({
        settledAt: new Date().toISOString(),
        ledgerPhase: 'available',
        stellarTransactionHash: hash,
      }),
    ]
  );

  return mapFundingSettlement(updated);
}

export type CollectionFundingResult = {
  status: CollectionFundingStatus;
  skipped: boolean;
  reason?: string;
  settlement?: ReturnType<typeof mapFundingSettlement>;
  stellarTransactionHash?: string | null;
  destinationPublicKey?: string;
};

/**
 * Treasury → org Stellar wallet after collection ledger credit.
 * Idempotent per collection: stellar:funding:collection:{txId}
 */
export async function fundCollectionStellarWallet(input: {
  orgId: string;
  environment: InfraEnvironment | string;
  collectionTransactionId: string;
  usdcAmount: number;
}): Promise<CollectionFundingResult> {
  const mode = getInfraStellarFundingMode();
  if (mode === 'off') {
    return { status: 'skipped', skipped: true, reason: 'funding_mode_off' };
  }

  const env = input.environment === 'live' ? 'live' : 'test';
  const amount = Math.round(Number(input.usdcAmount) * 1e7) / 1e7;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InfraStellarFundingError('Invalid USDC amount', 'INVALID_AMOUNT');
  }

  const idempotencyKey = `stellar:funding:collection:${input.collectionTransactionId}`;

  let settlement = await db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE org_id = $1 AND idempotency_key = $2`,
    [input.orgId, idempotencyKey]
  );

  if (settlement?.status === 'confirmed' && settlement.external_reference) {
    return {
      status: 'confirmed',
      skipped: false,
      settlement: mapFundingSettlement(settlement),
      stellarTransactionHash: settlement.external_reference,
      destinationPublicKey: settlement.destination_ref || undefined,
    };
  }

  if (settlement?.status === 'pending_treasury') {
    return {
      status: 'pending_treasury',
      skipped: false,
      reason: settlement.failure_reason || 'treasury_liquidity',
      settlement: mapFundingSettlement(settlement),
    };
  }

  let orgWallet;
  try {
    orgWallet = await getOrgStellarAccount(input.orgId, env);
    if (!orgWallet || orgWallet.status !== 'active') {
      orgWallet = await provisionOrgStellarAccount({
        orgId: input.orgId,
        environment: env,
        mode: mode === 'live' ? 'live' : 'mock',
      });
    }
  } catch (err: unknown) {
    const message =
      err instanceof InfraStellarAccountError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new InfraStellarFundingError(message, 'WALLET_PROVISION_FAILED', 502);
  }

  if (orgWallet.status !== 'active') {
    throw new InfraStellarFundingError(
      `Org Stellar wallet not active (${orgWallet.status})`,
      'WALLET_NOT_ACTIVE',
      409
    );
  }

  const destination = orgWallet.publicKey;

  await patchCollectionFundingMeta(input.collectionTransactionId, {
    mode,
    status: 'pending',
    destinationPublicKey: destination,
    usdcAmount: amount,
    startedAt: new Date().toISOString(),
  });

  if (mode === 'live') {
    const cfg = getStellarConfig();
    if (!cfg.isTestnet) {
      throw new InfraStellarFundingError(
        'Collection wallet funding live mode is Testnet-only in Increment C',
        'MAINNET_BLOCKED',
        400
      );
    }
    if (!treasurySecret()) {
      throw new InfraStellarFundingError(
        'DAYFI_STELLAR_SETTLEMENT_SECRET required for live funding',
        'MISSING_TREASURY_SECRET',
        500
      );
    }
    const balance = await treasuryUsdcBalance();
    if (balance == null) {
      throw new InfraStellarFundingError(
        'Unable to read treasury USDC balance',
        'TREASURY_BALANCE_UNKNOWN',
        502
      );
    }
    if (balance + 1e-7 < amount) {
      if (!settlement) {
        settlement = await db.one<SettlementRow>(
          `INSERT INTO infra_settlements
             (org_id, environment, collection_transaction_id, rail, asset, amount,
              destination_ref, status, idempotency_key, failure_reason, rail_metadata)
           VALUES ($1, $2, $3, 'STELLAR', 'USDC', $4, $5, 'pending_treasury', $6, $7, $8::jsonb)
           RETURNING id::text AS id, org_id::text AS org_id, environment,
                     collection_transaction_id::text AS collection_transaction_id,
                     rail, asset, amount::text, source_ref, destination_ref, status,
                     external_reference, idempotency_key, rail_metadata, failure_reason`,
          [
            input.orgId,
            env,
            input.collectionTransactionId,
            amount,
            destination,
            idempotencyKey,
            `Treasury USDC (${balance}) insufficient for ${amount}`,
            JSON.stringify({
              purpose: 'collection_wallet_funding',
              adapterMode: getStellarSettlementMode(),
              fundingMode: mode,
            }),
          ]
        );
      } else {
        await db.none(
          `UPDATE infra_settlements SET
             status = 'pending_treasury',
             failure_reason = $2,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            settlement.id,
            `Treasury USDC (${balance}) insufficient for ${amount}`,
          ]
        );
        settlement = await db.one<SettlementRow>(
          `${SETTLEMENT_SELECT} WHERE id = $1`,
          [settlement.id]
        );
      }
      await patchCollectionFundingMeta(input.collectionTransactionId, {
        mode,
        status: 'pending_treasury',
        settlementId: settlement.id,
        reason: settlement.failure_reason,
      });
      return {
        status: 'pending_treasury',
        skipped: false,
        reason: settlement.failure_reason || undefined,
        settlement: mapFundingSettlement(settlement),
        destinationPublicKey: destination,
      };
    }
  }

  if (!settlement) {
    settlement = await db.one<SettlementRow>(
      `INSERT INTO infra_settlements
         (org_id, environment, collection_transaction_id, rail, asset, amount,
          destination_ref, status, idempotency_key, rail_metadata)
       VALUES ($1, $2, $3, 'STELLAR', 'USDC', $4, $5, 'pending', $6, $7::jsonb)
       RETURNING id::text AS id, org_id::text AS org_id, environment,
                 collection_transaction_id::text AS collection_transaction_id,
                 rail, asset, amount::text, source_ref, destination_ref, status,
                 external_reference, idempotency_key, rail_metadata, failure_reason`,
      [
        input.orgId,
        env,
        input.collectionTransactionId,
        amount,
        destination,
        idempotencyKey,
        JSON.stringify({
          purpose: 'collection_wallet_funding',
          adapterMode: getStellarSettlementMode(),
          fundingMode: mode,
          stellarAccountId: orgWallet.id,
        }),
      ]
    );
  }

  let payment;
  try {
    payment = await submitUsdcPayment({
      destination,
      amount,
      memo: `fund:${String(input.collectionTransactionId).replace(/-/g, '').slice(0, 20)}`,
    });
  } catch (err: unknown) {
    const reason =
      err instanceof StellarSettlementAdapterError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Stellar funding submit failed';

    await db.none(
      `UPDATE infra_settlements SET
         status = 'failed',
         failure_reason = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [settlement.id, reason]
    );
    await patchCollectionFundingMeta(input.collectionTransactionId, {
      mode,
      status: 'failed',
      settlementId: settlement.id,
      failureReason: reason,
    });
    throw new InfraStellarFundingError(reason, 'STELLAR_FUNDING_FAILED', 502);
  }

  await db.none(
    `UPDATE infra_settlements SET
       status = 'submitted',
       source_ref = $2,
       destination_ref = $3,
       external_reference = $4,
       provider_reference = $4,
       submitted_at = CURRENT_TIMESTAMP,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $5::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      settlement.id,
      payment.sourceAccount,
      payment.destinationAccount,
      payment.transactionHash,
      JSON.stringify({
        stellar: {
          transactionHash: payment.transactionHash,
          ledgerSequence: payment.ledgerSequence,
          mode: payment.mode,
          amount: payment.amount,
        },
      }),
    ]
  );

  settlement = await db.one<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE id = $1`,
    [settlement.id]
  );

  const shouldConfirm =
    payment.mode === 'mock' ||
    payment.ledgerSequence != null ||
    String(payment.raw?.finalStatus || '')
      .toUpperCase()
      .includes('SUCCESS');

  if (shouldConfirm) {
    const confirmed = await confirmCollectionFunding(settlement, {
      hash: payment.transactionHash,
      ledgerSequence: payment.ledgerSequence,
    });
    return {
      status: 'confirmed',
      skipped: false,
      settlement: confirmed,
      stellarTransactionHash: payment.transactionHash,
      destinationPublicKey: destination,
    };
  }

  const verified = await verifyUsdcPayment(payment.transactionHash);
  if (verified.confirmed) {
    const confirmed = await confirmCollectionFunding(settlement, {
      hash: payment.transactionHash,
      ledgerSequence: verified.ledgerSequence,
    });
    return {
      status: 'confirmed',
      skipped: false,
      settlement: confirmed,
      stellarTransactionHash: payment.transactionHash,
      destinationPublicKey: destination,
    };
  }

  await patchCollectionFundingMeta(input.collectionTransactionId, {
    mode,
    status: 'submitted',
    settlementId: settlement.id,
    stellarTransactionHash: payment.transactionHash,
  });

  return {
    status: 'submitted',
    skipped: false,
    settlement: mapFundingSettlement(settlement),
    stellarTransactionHash: payment.transactionHash,
    destinationPublicKey: destination,
  };
}

export async function getCollectionFundingSettlement(
  orgId: string,
  collectionTransactionId: string
) {
  const row = await db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT}
     WHERE org_id = $1 AND collection_transaction_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, collectionTransactionId]
  );
  return row ? mapFundingSettlement(row) : null;
}
