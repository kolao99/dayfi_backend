/**
 * Phase 2 money lifecycle — Infrastructure Collect / Send.
 *
 * Collect: create payment = intent only. CREDIT only after verified settlement.
 * Send: LOCK available → provider → finalize locked debit | release lock on failure.
 */

import { db } from '../../config/database';
import { convertAmountToUsd } from '../payment/fxService';
import {
  creditOrgWallet,
  creditOrgWalletPending,
  finalizeLockedDebit,
  getOrgBalance,
  InfraLedgerError,
  lockOrgFunds,
  releaseOrgFunds,
  type InfraBalanceView,
  type InfraEnvironment,
  type InfraLedgerMovement,
} from './infraLedgerService';
import {
  isYellowCardReceiveWebhookEvent,
  isYellowCardSendWebhookEvent,
  resolveWalletStatusFromYellowCardWebhook,
  type YellowCardWebhookPayload,
} from '../payment/yellowCardWebhook';
import {
  fundCollectionStellarWallet,
  getInfraStellarFundingMode,
  type CollectionFundingResult,
} from './infraStellarFundingService';

type TxRow = {
  id: string;
  org_id: string;
  environment: string;
  amount: string;
  currency: string;
  status: string;
  direction: string;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
};

export class InfraLifecycleError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 409) {
    super(message);
    this.name = 'InfraLifecycleError';
    this.status = status;
    this.code = code;
  }
}

function asEnv(env: string): InfraEnvironment {
  return env === 'live' ? 'live' : 'test';
}

export async function resolveUsdcAmount(
  amount: number,
  currency: string
): Promise<{ usdcAmount: number; rate: number | null; sourceCurrency: string }> {
  const cur = String(currency || 'USDC').toUpperCase();
  if (cur === 'USDC' || cur === 'USD') {
    return { usdcAmount: Math.round(amount * 1e7) / 1e7, rate: 1, sourceCurrency: cur };
  }
  const { usdAmount, rate } = await convertAmountToUsd(amount, cur);
  return {
    usdcAmount: Math.round(Number(usdAmount) * 1e7) / 1e7,
    rate,
    sourceCurrency: cur,
  };
}

function metaUsdc(row: TxRow): number | null {
  const m = row.metadata || {};
  const v = m.usdcAmount ?? m.ledgerAmount ?? m.settlementUsdc;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadTx(id: string, orgId?: string): Promise<TxRow | null> {
  if (orgId) {
    return db.oneOrNone<TxRow>(
      `SELECT id::text AS id, org_id::text AS org_id, environment, amount::text, currency,
              status, direction, external_id, metadata
       FROM infra_transactions
       WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
  }
  return db.oneOrNone<TxRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, amount::text, currency,
            status, direction, external_id, metadata
     FROM infra_transactions
     WHERE id = $1`,
    [id]
  );
}

async function loadTxByExternalId(externalId: string): Promise<TxRow | null> {
  return db.oneOrNone<TxRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, amount::text, currency,
            status, direction, external_id, metadata
     FROM infra_transactions
     WHERE external_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [externalId]
  );
}

async function patchTx(
  id: string,
  status: string,
  metadataPatch: Record<string, unknown>
): Promise<void> {
  await db.none(
    `UPDATE infra_transactions
     SET status = $2,
         metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
     WHERE id = $1`,
    [id, status, JSON.stringify(metadataPatch)]
  );
}

/** Verified collection settlement → pending or available USDC (idempotent). */
export async function settleCollectionCredit(input: {
  orgId: string;
  transactionId: string;
  providerEventId?: string;
  source?: string;
}): Promise<{
  transactionId: string;
  credit: InfraLedgerMovement;
  balance: InfraBalanceView;
  usdcAmount: number;
  walletFunding?: CollectionFundingResult;
  ledgerPhase?: 'pending' | 'available';
}> {
  const row = await loadTx(input.transactionId, input.orgId);
  if (!row) throw new Error('Collection not found');
  if (row.direction !== 'payment') {
    throw new Error('Transaction is not a collection');
  }

  const alreadySettled = ['settled', 'completed', 'success'].includes(
    String(row.status).toLowerCase()
  );

  let usdcAmount = metaUsdc(row);
  let rate: number | null = null;
  if (usdcAmount == null) {
    const resolved = await resolveUsdcAmount(Number(row.amount), row.currency);
    usdcAmount = resolved.usdcAmount;
    rate = resolved.rate;
  }

  const fundingMode = getInfraStellarFundingMode();
  const usesWalletFunding = fundingMode !== 'off';

  const creditMeta = {
    source: input.source || 'settlement',
    fiatAmount: Number(row.amount),
    fiatCurrency: row.currency,
    rate,
    providerEventId: input.providerEventId || null,
    ledgerPhase: usesWalletFunding ? 'pending' : 'available',
  };

  const credit = usesWalletFunding
    ? await creditOrgWalletPending({
        orgId: row.org_id,
        environment: asEnv(row.environment),
        amount: usdcAmount,
        idempotencyKey: `collection:${row.id}:pending`,
        movementType: 'collection_pending',
        referenceType: 'collection',
        referenceId: row.id,
        reference: row.external_id || row.id,
        metadata: creditMeta,
      })
    : await creditOrgWallet({
        orgId: row.org_id,
        environment: asEnv(row.environment),
        amount: usdcAmount,
        idempotencyKey: `collection:${row.id}:credit`,
        movementType: 'collection_credit',
        referenceType: 'collection',
        referenceId: row.id,
        reference: row.external_id || row.id,
        metadata: creditMeta,
      });

  const statusAfterCredit = usesWalletFunding ? 'processing' : 'settled';

  if (!alreadySettled) {
    await patchTx(row.id, statusAfterCredit, {
      settledAt: usesWalletFunding ? null : new Date().toISOString(),
      usdcAmount,
      rate,
      ledgerCreditId: credit.id,
      settlementSource: input.source || 'settlement',
      walletFundingExpected: usesWalletFunding,
    });
  } else {
    await patchTx(row.id, row.status, {
      usdcAmount,
      ledgerCreditId: credit.id,
    });
  }

  let walletFunding: CollectionFundingResult | undefined;
  if (usesWalletFunding) {
    try {
      walletFunding = await fundCollectionStellarWallet({
        orgId: row.org_id,
        environment: asEnv(row.environment),
        collectionTransactionId: row.id,
        usdcAmount,
      });
    } catch (err) {
      console.error(
        '[infra] collection wallet funding failed',
        row.id,
        err instanceof Error ? err.message : err
      );
      walletFunding = {
        status: 'failed',
        skipped: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const balance = await getOrgBalance(row.org_id, asEnv(row.environment));
  const ledgerPhase =
    usesWalletFunding && walletFunding?.status === 'confirmed'
      ? 'available'
      : usesWalletFunding
        ? 'pending'
        : 'available';

  return {
    transactionId: row.id,
    credit,
    balance,
    usdcAmount,
    walletFunding,
    ledgerPhase,
  };
}

/** Reserve USDC for a payout (available → locked). */
export async function lockPayoutFunds(input: {
  orgId: string;
  transactionId: string;
  usdcAmount?: number;
}): Promise<{
  lock: InfraLedgerMovement;
  usdcAmount: number;
  balance: InfraBalanceView;
}> {
  const row = await loadTx(input.transactionId, input.orgId);
  if (!row) throw new Error('Payout not found');
  if (row.direction !== 'payout') throw new Error('Transaction is not a payout');

  let usdcAmount = input.usdcAmount ?? metaUsdc(row);
  let rate: number | null = null;
  if (usdcAmount == null) {
    const resolved = await resolveUsdcAmount(Number(row.amount), row.currency);
    usdcAmount = resolved.usdcAmount;
    rate = resolved.rate;
  }

  const lock = await lockOrgFunds({
    orgId: row.org_id,
    environment: asEnv(row.environment),
    amount: usdcAmount,
    idempotencyKey: `payout:${row.id}:lock`,
    movementType: 'funds_lock',
    referenceType: 'payout',
    referenceId: row.id,
    reference: row.external_id || row.id,
    metadata: {
      fiatAmount: Number(row.amount),
      fiatCurrency: row.currency,
      rate,
    },
  });

  await patchTx(row.id, row.status, {
    usdcAmount,
    rate,
    fundsLocked: true,
    ledgerLockId: lock.id,
  });

  const balance = await getOrgBalance(row.org_id, asEnv(row.environment));
  return { lock, usdcAmount, balance };
}

/** Provider success → consume locked USDC. */
export async function finalizePayoutDebit(input: {
  orgId?: string;
  transactionId: string;
  providerEventId?: string;
  source?: string;
}): Promise<{ finalize: InfraLedgerMovement; balance: InfraBalanceView }> {
  const row = await loadTx(input.transactionId, input.orgId);
  if (!row) throw new Error('Payout not found');
  if (row.direction !== 'payout') throw new Error('Transaction is not a payout');

  const meta = row.metadata || {};
  if (meta.fundsReleased === true) {
    throw new InfraLifecycleError(
      'Payout already released',
      'PAYOUT_ALREADY_RELEASED',
      409
    );
  }

  const usdcAmount = metaUsdc(row);
  if (usdcAmount == null) throw new Error('Payout has no locked USDC amount');

  const finalize = await finalizeLockedDebit({
    orgId: row.org_id,
    environment: asEnv(row.environment),
    amount: usdcAmount,
    idempotencyKey: `payout:${row.id}:finalize`,
    movementType: 'payout_settle',
    referenceType: 'payout',
    referenceId: row.id,
    reference: row.external_id || row.id,
    metadata: {
      source: input.source || 'settlement',
      providerEventId: input.providerEventId || null,
    },
  });

  await patchTx(row.id, 'settled', {
    settledAt: new Date().toISOString(),
    fundsLocked: false,
    fundsFinalized: true,
    ledgerFinalizeId: finalize.id,
    settlementSource: input.source || 'settlement',
  });

  const balance = await getOrgBalance(row.org_id, asEnv(row.environment));
  return { finalize, balance };
}

/** Provider failure → return locked USDC to available. */
export async function releasePayoutLock(input: {
  orgId?: string;
  transactionId: string;
  providerEventId?: string;
  source?: string;
  status?: string;
}): Promise<{ release: InfraLedgerMovement; balance: InfraBalanceView }> {
  const row = await loadTx(input.transactionId, input.orgId);
  if (!row) throw new Error('Payout not found');
  if (row.direction !== 'payout') throw new Error('Transaction is not a payout');

  const meta = row.metadata || {};
  if (meta.fundsFinalized === true) {
    throw new InfraLifecycleError(
      'Payout already finalized',
      'PAYOUT_ALREADY_FINALIZED',
      409
    );
  }

  const usdcAmount = metaUsdc(row);
  if (usdcAmount == null) throw new Error('Payout has no locked USDC amount');

  const release = await releaseOrgFunds({
    orgId: row.org_id,
    environment: asEnv(row.environment),
    amount: usdcAmount,
    idempotencyKey: `payout:${row.id}:release`,
    movementType: 'funds_release',
    referenceType: 'payout',
    referenceId: row.id,
    reference: row.external_id || row.id,
    metadata: {
      source: input.source || 'failure',
      providerEventId: input.providerEventId || null,
    },
  });

  await patchTx(row.id, input.status || 'failed', {
    failedAt: new Date().toISOString(),
    fundsLocked: false,
    fundsReleased: true,
    ledgerReleaseId: release.id,
    settlementSource: input.source || 'failure',
  });

  const balance = await getOrgBalance(row.org_id, asEnv(row.environment));
  return { release, balance };
}

/** Apply verified Yellow Card webhook to infra payment/payout. */
export async function applyInfraYellowCardWebhook(
  payload: YellowCardWebhookPayload
): Promise<{ handled: boolean; action?: string; transactionId?: string }> {
  const sequenceId = String(payload.sequenceId || payload.id || '').trim();
  if (!sequenceId) return { handled: false };

  const row = await loadTxByExternalId(sequenceId);
  if (!row) return { handled: false };

  const event = String(payload.event || '').trim();
  const mapped = resolveWalletStatusFromYellowCardWebhook(payload);
  const providerEventId = String(
    payload.id || `${sequenceId}:${payload.status || event || 'event'}`
  );

  if (row.direction === 'payment' || isYellowCardReceiveWebhookEvent(event)) {
    if (row.direction !== 'payment') return { handled: false };
    const settled = ['settled', 'completed', 'success'].includes(
      String(row.status).toLowerCase()
    );
    if (mapped === 'success-payment') {
      await settleCollectionCredit({
        orgId: row.org_id,
        transactionId: row.id,
        providerEventId,
        source: 'yellowcard_webhook',
      });
      return { handled: true, action: 'collection_credit', transactionId: row.id };
    }
    if (mapped === 'failed-payment') {
      if (settled) {
        return {
          handled: true,
          action: 'collection_already_settled',
          transactionId: row.id,
        };
      }
      await patchTx(row.id, 'failed', {
        failedAt: new Date().toISOString(),
        providerEventId,
        settlementSource: 'yellowcard_webhook',
      });
      return { handled: true, action: 'collection_failed', transactionId: row.id };
    }
    return { handled: true, action: 'collection_pending', transactionId: row.id };
  }

  if (row.direction === 'payout' || isYellowCardSendWebhookEvent(event)) {
    if (row.direction !== 'payout') return { handled: false };
    const meta = row.metadata || {};
    if (mapped === 'success-payment') {
      if (meta.fundsReleased === true) {
        return {
          handled: true,
          action: 'payout_already_released',
          transactionId: row.id,
        };
      }
      if (meta.offRamp === true && meta.stellarConfirmed !== true) {
        return {
          handled: true,
          action: 'offramp_awaiting_stellar',
          transactionId: row.id,
        };
      }
      try {
        await finalizePayoutDebit({
          transactionId: row.id,
          providerEventId,
          source: 'yellowcard_webhook',
        });
      } catch (err) {
        if (
          err instanceof InfraLifecycleError &&
          err.code === 'PAYOUT_ALREADY_RELEASED'
        ) {
          return {
            handled: true,
            action: 'payout_already_released',
            transactionId: row.id,
          };
        }
        throw err;
      }
      if (meta.offRamp === true) {
        await db.none(
          `UPDATE infra_settlements SET
             status = 'confirmed',
             confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
             external_reference = COALESCE(external_reference, $2),
             provider_reference = COALESCE(provider_reference, $2),
             failure_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
           WHERE payout_transaction_id = $1 AND rail = 'YELLOW_CARD'`,
          [row.id, providerEventId]
        );
        await patchTx(row.id, 'settled', {
          offRampPhase: 'completed',
          providerRetryRequired: false,
          providerConfirmed: true,
        });
      }
      return { handled: true, action: 'payout_finalize', transactionId: row.id };
    }
    if (mapped === 'failed-payment') {
      if (meta.fundsFinalized === true) {
        return {
          handled: true,
          action: 'payout_already_finalized',
          transactionId: row.id,
        };
      }
      // Increment H: after Stellar treasury receipt, Provider failure must not unlock Alice.
      if (meta.offRamp === true && meta.stellarConfirmed === true) {
        await patchTx(row.id, 'processing', {
          offRampPhase: 'provider_failed',
          providerRetryRequired: true,
          providerEventId,
          settlementSource: 'yellowcard_webhook',
          providerFailureReason: payload.status || event || 'provider_failed',
        });
        await db.none(
          `UPDATE infra_settlements SET
             status = 'failed',
             failure_reason = $2,
             updated_at = CURRENT_TIMESTAMP
           WHERE payout_transaction_id = $1
             AND rail = 'YELLOW_CARD'
             AND status IN ('pending', 'submitted')`,
          [
            row.id,
            String(payload.status || event || 'provider_failed').slice(0, 500),
          ]
        );
        return {
          handled: true,
          action: 'offramp_provider_retry_required',
          transactionId: row.id,
        };
      }
      try {
        await releasePayoutLock({
          transactionId: row.id,
          providerEventId,
          source: 'yellowcard_webhook',
          status: 'failed',
        });
      } catch (err) {
        if (
          err instanceof InfraLifecycleError &&
          err.code === 'PAYOUT_ALREADY_FINALIZED'
        ) {
          return {
            handled: true,
            action: 'payout_already_finalized',
            transactionId: row.id,
          };
        }
        throw err;
      }
      return { handled: true, action: 'payout_release', transactionId: row.id };
    }
    return { handled: true, action: 'payout_pending', transactionId: row.id };
  }

  return { handled: false };
}

export { InfraLedgerError };
