/**
 * Increment H — Fiat withdrawal / off-ramp.
 *
 * Ordering (required):
 *   lock → Alice Stellar USDC → Dayfi treasury → confirm → Provider payout → complete
 *
 * Provider failure after Stellar success does NOT unlock Alice and does NOT
 * pretend the bank was paid. Funds remain treasury-held until retry succeeds.
 *
 * Mode: DAYFI_INFRA_FIAT_OFFRAMP_MODE = off | mock | live (default off).
 */

import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import YellowCardService, {
  parseYellowCardChannelList,
} from '../payment/yellowCardService';
import {
  finalizePayoutDebit,
  releasePayoutLock,
} from './infraLifecycleService';
import { getOrgBalance } from './infraLedgerService';
import {
  getOrgStellarSigningSecret,
  InfraStellarAccountError,
} from './infraStellarAccountService';
import {
  assertNetworkFeeReserve,
  getStellarFeePayerSigningSecret,
} from './infraStellarFeePayerService';
import { getDayfiTreasuryPublicKey } from './infraStellarFundingService';
import {
  getStellarSettlementMode,
  prepareSponsoredUsdcPayment,
  StellarSettlementAdapterError,
  submitPreparedSponsoredPayment,
  verifyUsdcPayment,
} from './stellarSettlementAdapter';

export type FiatOfframpMode = 'off' | 'mock' | 'live';

export class InfraFiatWithdrawalError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraFiatWithdrawalError';
    this.code = code;
    this.status = status;
  }
}

type TxRow = {
  id: string;
  org_id: string;
  environment: string;
  amount: string;
  currency: string;
  country: string | null;
  status: string;
  method: string;
  direction: string;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
};

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
  rail_metadata: Record<string, unknown> | null;
  failure_reason: string | null;
  idempotency_key: string;
  submitted_at: Date | null;
  confirmed_at: Date | null;
};

const SETTLEMENT_RETURNING = `id::text AS id, org_id::text AS org_id, environment,
  payout_transaction_id::text AS payout_transaction_id, rail, asset, amount::text,
  source_ref, destination_ref, status, external_reference, provider_reference,
  rail_metadata, failure_reason, idempotency_key, submitted_at, confirmed_at`;

const SETTLEMENT_SELECT = `SELECT ${SETTLEMENT_RETURNING}
 FROM infra_settlements`;

export function getInfraFiatOfframpMode(): FiatOfframpMode {
  const raw = String(process.env.DAYFI_INFRA_FIAT_OFFRAMP_MODE || 'off')
    .trim()
    .toLowerCase();
  if (raw === 'mock' || raw === 'live' || raw === 'off') return raw;
  return 'off';
}

export function isFiatOfframpEnabled(): boolean {
  return getInfraFiatOfframpMode() !== 'off';
}

function asEnv(env: string): 'test' | 'live' {
  return env === 'live' ? 'live' : 'test';
}

function mapSettlement(row: SettlementRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment,
    payoutTransactionId: row.payout_transaction_id,
    rail: row.rail,
    asset: row.asset,
    amount: Number(row.amount),
    sourceRef: row.source_ref,
    destinationRef: row.destination_ref,
    status: row.status,
    externalReference: row.external_reference,
    providerReference: row.provider_reference,
    railMetadata: row.rail_metadata || {},
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
  };
}

async function loadPayout(orgId: string, payoutId: string): Promise<TxRow> {
  const row = await db.oneOrNone<TxRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, amount::text, currency,
            country, status, method, direction, external_id, metadata
     FROM infra_transactions
     WHERE id = $1 AND org_id = $2 AND direction = 'payout'`,
    [payoutId, orgId]
  );
  if (!row) {
    throw new InfraFiatWithdrawalError('Payout not found', 'PAYOUT_NOT_FOUND', 404);
  }
  return row;
}

async function patchPayoutMeta(
  payoutId: string,
  patch: Record<string, unknown>,
  status?: string
): Promise<void> {
  if (status) {
    await db.none(
      `UPDATE infra_transactions SET
         status = $2,
         metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       WHERE id = $1`,
      [payoutId, status, JSON.stringify(patch)]
    );
    return;
  }
  await db.none(
    `UPDATE infra_transactions SET
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [payoutId, JSON.stringify(patch)]
  );
}

async function loadSettlementByKey(
  orgId: string,
  idempotencyKey: string
): Promise<SettlementRow | null> {
  return db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT} WHERE org_id = $1 AND idempotency_key = $2`,
    [orgId, idempotencyKey]
  );
}

async function loadSettlementByRail(
  payoutId: string,
  rail: string
): Promise<SettlementRow | null> {
  return db.oneOrNone<SettlementRow>(
    `${SETTLEMENT_SELECT}
     WHERE payout_transaction_id = $1 AND rail = $2
     ORDER BY created_at DESC LIMIT 1`,
    [payoutId, rail]
  );
}

function usdcAmountFromPayout(payout: TxRow): number {
  const meta = payout.metadata || {};
  const n = Number(meta.usdcAmount);
  if (Number.isFinite(n) && n > 0) return n;
  if (String(payout.currency || '').toUpperCase() === 'USDC') {
    const amt = Number(payout.amount);
    if (Number.isFinite(amt) && amt > 0) return amt;
  }
  throw new InfraFiatWithdrawalError(
    'Payout has no locked USDC amount',
    'NO_USDC_AMOUNT',
    409
  );
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

async function assertHorizonPayment(input: {
  hash: string;
  source: string;
  destination: string;
  amount: number;
}): Promise<{ feeChargedStroops: string | null; feeAccount: string | null }> {
  if (getStellarSettlementMode() === 'mock') {
    return { feeChargedStroops: '100', feeAccount: null };
  }
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const issuer = resolveUsdcIssuer(true);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const tx = await server.transactions().transaction(input.hash).call();
      if (tx.successful !== true) {
        throw new InfraFiatWithdrawalError(
          'Stellar transaction did not succeed',
          'STELLAR_TX_FAILED',
          502
        );
      }
      const ops = await server.operations().forTransaction(input.hash).call();
      const payment = ops.records.find(
        (op: Record<string, unknown>) => op.type === 'payment'
      ) as Record<string, unknown> | undefined;
      if (!payment) {
        throw new InfraFiatWithdrawalError(
          'No payment operation on Stellar transaction',
          'STELLAR_NO_PAYMENT',
          502
        );
      }
      if (String(payment.from) !== input.source) {
        throw new InfraFiatWithdrawalError(
          'Stellar source does not match Alice wallet',
          'STELLAR_SOURCE_MISMATCH',
          502
        );
      }
      if (String(payment.to) !== input.destination) {
        throw new InfraFiatWithdrawalError(
          'Stellar destination does not match Dayfi treasury',
          'STELLAR_DEST_MISMATCH',
          502
        );
      }
      if (String(payment.asset_code) !== 'USDC' || String(payment.asset_issuer) !== issuer) {
        throw new InfraFiatWithdrawalError(
          'Stellar asset is not expected USDC',
          'STELLAR_ASSET_MISMATCH',
          502
        );
      }
      if (Math.abs(Number(payment.amount) - input.amount) > 1e-7) {
        throw new InfraFiatWithdrawalError(
          'Stellar amount does not match withdrawal',
          'STELLAR_AMOUNT_MISMATCH',
          502
        );
      }
      const feeAccount =
        (tx as { fee_account?: string }).fee_account ||
        (tx as { fee_bump_transaction?: { fee_source?: string } }).fee_bump_transaction
          ?.fee_source ||
        null;
      return {
        feeChargedStroops:
          (tx as { fee_charged?: string | number }).fee_charged != null
            ? String((tx as { fee_charged?: string | number }).fee_charged)
            : null,
        feeAccount,
      };
    } catch (err) {
      if (err instanceof InfraFiatWithdrawalError) throw err;
      lastErr = err;
      const status =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined;
      if (status !== 404 || attempt === 23) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new InfraFiatWithdrawalError(
    `Unable to verify Stellar tx on Horizon: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`.slice(0, 400),
    'HORIZON_VERIFY_FAILED',
    502
  );
}

async function settleStellarToTreasury(input: {
  orgId: string;
  payout: TxRow;
  usdcAmount: number;
}): Promise<SettlementRow> {
  const env = asEnv(input.payout.environment);
  const mode = getInfraFiatOfframpMode();
  const stellarIdem = `stellar:offramp:${input.payout.id}`;
  const existing = await loadSettlementByKey(input.orgId, stellarIdem);
  if (existing?.status === 'confirmed') return existing;

  const treasuryPk = getDayfiTreasuryPublicKey();
  if (!treasuryPk) {
    throw new InfraFiatWithdrawalError(
      'Dayfi treasury public key is not configured',
      'TREASURY_UNCONFIGURED',
      503
    );
  }

  const alice = await getOrgStellarSigningSecret(input.orgId, env);
  if (alice.publicKey === treasuryPk) {
    throw new InfraFiatWithdrawalError(
      'Alice wallet cannot be the Dayfi treasury',
      'TREASURY_IS_SOURCE',
      400
    );
  }

  if (mode === 'live') {
    const onChain = await orgWalletUsdcBalance(alice.publicKey);
    if (onChain + 1e-7 < input.usdcAmount) {
      throw new InfraFiatWithdrawalError(
        `Org Stellar USDC (${onChain}) insufficient for ${input.usdcAmount}`,
        'INSUFFICIENT_ONCHAIN_BALANCE',
        409
      );
    }
  }

  await assertNetworkFeeReserve();
  const feePayerSecret = getStellarFeePayerSigningSecret();
  const feePayerPk = StellarSdk.Keypair.fromSecret(feePayerSecret).publicKey();

  let settlement =
    existing ||
    (await db.one<SettlementRow>(
      `INSERT INTO infra_settlements
         (org_id, environment, payout_transaction_id, rail, asset, amount,
          source_ref, destination_ref, status, idempotency_key, rail_metadata)
       VALUES ($1,$2,$3,'STELLAR','USDC',$4,$5,$6,'pending',$7,$8::jsonb)
       RETURNING ${SETTLEMENT_RETURNING}`,
      [
        input.orgId,
        env,
        input.payout.id,
        input.usdcAmount,
        alice.publicKey,
        treasuryPk,
        stellarIdem,
        JSON.stringify({
          purpose: 'fiat_offramp_treasury',
          envelopeType: 'FEE_BUMP',
          usdcSource: alice.publicKey,
          feePayerPublicKey: feePayerPk,
          signingSource: 'org_wallet',
        }),
      ]
    ));

  await patchPayoutMeta(input.payout.id, {
    offRampPhase: 'stellar_submitted',
    offRamp: true,
  });

  let prepared = {
    xdr: '',
    transactionHash: settlement.external_reference || '',
    innerSourcePublicKey: alice.publicKey,
    feePayerPublicKey: feePayerPk,
    destinationAccount: treasuryPk,
    amount: String(input.usdcAmount),
    envelopeType: 'FEE_BUMP' as const,
  };
  const meta = settlement.rail_metadata || {};
  if (typeof meta.pendingEnvelopeXdr === 'string' && meta.pendingTransactionHash) {
    prepared = {
      xdr: String(meta.pendingEnvelopeXdr),
      transactionHash: String(meta.pendingTransactionHash),
      innerSourcePublicKey: alice.publicKey,
      feePayerPublicKey: feePayerPk,
      destinationAccount: treasuryPk,
      amount: String(input.usdcAmount),
      envelopeType: 'FEE_BUMP',
    };
  } else {
    prepared = await prepareSponsoredUsdcPayment({
      destination: treasuryPk,
      amount: input.usdcAmount,
      memo: `dayfi:h:${String(input.payout.id).replace(/-/g, '').slice(0, 20)}`,
      sourceSecret: alice.secret,
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
        }),
      ]
    );
  }

  let payment;
  try {
    payment = await submitPreparedSponsoredPayment(prepared);
  } catch (err: unknown) {
    const reason =
      err instanceof StellarSettlementAdapterError ||
      err instanceof InfraStellarAccountError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Stellar submit failed';
    await db.none(
      `UPDATE infra_settlements SET
         status = 'failed',
         failure_reason = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [settlement.id, reason.slice(0, 500)]
    );
    await releasePayoutLock({
      orgId: input.orgId,
      transactionId: input.payout.id,
      source: 'offramp_stellar_failed',
      status: 'failed',
    });
    await patchPayoutMeta(input.payout.id, {
      offRampPhase: 'stellar_failed',
      stellarFailureReason: reason,
    });
    throw new InfraFiatWithdrawalError(reason, 'STELLAR_SUBMIT_FAILED', 502);
  }

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
      payment.innerSourcePublicKey,
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

  const verified = await verifyUsdcPayment(payment.transactionHash);
  const mockOk = getStellarSettlementMode() === 'mock' || payment.mode === 'mock';
  if (!mockOk && !verified.confirmed && payment.ledgerSequence == null) {
    if (String(verified.status || '').toUpperCase().includes('FAIL')) {
      await db.none(
        `UPDATE infra_settlements SET status = 'failed', failure_reason = $2,
           updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [settlement.id, `On-chain failure: ${verified.status}`]
      );
      await releasePayoutLock({
        orgId: input.orgId,
        transactionId: input.payout.id,
        source: 'offramp_stellar_confirm_failed',
        status: 'failed',
      });
      throw new InfraFiatWithdrawalError(
        `Stellar confirmation failed (${verified.status})`,
        'STELLAR_CONFIRM_FAILED',
        502
      );
    }
    throw new InfraFiatWithdrawalError(
      `Settlement not confirmed on-chain (status=${verified.status})`,
      'NOT_CONFIRMED',
      409
    );
  }

  const horizon = await assertHorizonPayment({
    hash: payment.transactionHash,
    source: alice.publicKey,
    destination: treasuryPk,
    amount: input.usdcAmount,
  });

  await db.none(
    `UPDATE infra_settlements SET
       status = 'confirmed',
       confirmed_at = CURRENT_TIMESTAMP,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $2::jsonb,
       failure_reason = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      settlement.id,
      JSON.stringify({
        treasuryReceived: true,
        horizonFeeChargedStroops: horizon.feeChargedStroops,
        horizonFeeAccount: horizon.feeAccount,
        actualNetworkFeeXlm: payment.actualNetworkFeeXlm,
        actualNetworkFeeStroops:
          payment.actualNetworkFeeStroops || horizon.feeChargedStroops,
      }),
    ]
  );

  await patchPayoutMeta(input.payout.id, {
    offRampPhase: 'treasury_received',
    stellarConfirmed: true,
    stellarTransactionHash: payment.transactionHash,
    treasuryPublicKey: treasuryPk,
    actualNetworkFeeXlm: payment.actualNetworkFeeXlm,
    actualNetworkFeeStroops:
      payment.actualNetworkFeeStroops || horizon.feeChargedStroops,
  });

  return (await loadSettlementByKey(input.orgId, stellarIdem))!;
}

async function submitProviderPayout(input: {
  orgId: string;
  payout: TxRow;
  usdcAmount: number;
}): Promise<SettlementRow> {
  const env = asEnv(input.payout.environment);
  const mode = getInfraFiatOfframpMode();
  const providerIdem = `provider:offramp:${input.payout.id}`;
  const existing = await loadSettlementByKey(input.orgId, providerIdem);
  if (existing?.status === 'confirmed') return existing;

  const meta = input.payout.metadata || {};
  const recipient = (meta.recipient || {}) as Record<string, unknown>;
  const sequenceId = String(meta.sequenceId || input.payout.external_id || input.payout.id);

  let settlement =
    existing ||
    (await db.one<SettlementRow>(
      `INSERT INTO infra_settlements
         (org_id, environment, payout_transaction_id, rail, asset, amount,
          source_ref, destination_ref, status, idempotency_key, rail_metadata)
       VALUES ($1,$2,$3,'YELLOW_CARD',$4,$5,$6,$7,'pending',$8,$9::jsonb)
       RETURNING ${SETTLEMENT_RETURNING}`,
      [
        input.orgId,
        env,
        input.payout.id,
        String(input.payout.currency || 'USDC').toUpperCase() === 'USDC'
          ? 'USDC'
          : String(input.payout.currency || 'NGN').toUpperCase(),
        Number(input.payout.amount),
        'dayfi_treasury',
        String(recipient.accountNumber || recipient.displayHint || 'bank'),
        providerIdem,
        JSON.stringify({
          purpose: 'fiat_offramp_provider',
          sequenceId,
          usdcAmount: input.usdcAmount,
        }),
      ]
    ));

  if (String(process.env.DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL || '') === '1') {
    await db.none(
      `UPDATE infra_settlements SET
         status = 'failed',
         failure_reason = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [settlement.id, 'Forced Provider failure']
    );
    await patchPayoutMeta(
      input.payout.id,
      {
        offRampPhase: 'provider_failed',
        providerRetryRequired: true,
        providerFailureReason: 'Forced Provider failure',
      },
      'processing'
    );
    throw new InfraFiatWithdrawalError(
      'Forced Provider failure',
      'PROVIDER_FAILED',
      502
    );
  }

  await patchPayoutMeta(input.payout.id, { offRampPhase: 'provider_submitted' });

  let provider: Record<string, unknown>;
  if (mode === 'mock' || env === 'test') {
    provider = {
      id: `mock-provider-${sequenceId}`,
      sequenceId,
      status: 'complete',
      amount: Number(input.payout.amount),
      currency: input.payout.currency,
      simulated: true,
      rail: 'PROVIDER',
    };
  } else {
    const yc = new YellowCardService();
    if (!yc.isConfigured()) {
      throw new InfraFiatWithdrawalError(
        'Provider is not configured for LIVE offramp',
        'PROVIDER_UNCONFIGURED',
        503
      );
    }
    try {
      const channelList = parseYellowCardChannelList(await yc.fetchChannels());
      const country = String(input.payout.country || 'NG').toUpperCase();
      const currency = String(input.payout.currency || 'NGN').toUpperCase();
      const channelId =
        String(meta.channelId || '') ||
        String(
          channelList.find(
            (c) =>
              String(c.country || '').toUpperCase() === country &&
              String(c.currency || c.localCurrency || '').toUpperCase() === currency
          )?.id ??
            channelList[0]?.id ??
            channelList[0]?.channelId ??
            ''
        );
      if (!channelId) {
        throw new InfraFiatWithdrawalError(
          'No Provider payout channel available',
          'NO_PROVIDER_CHANNEL',
          502
        );
      }
      const destType =
        input.payout.method === 'mobile_money' ? 'momo' : 'bank';
      const ycParty = (meta.ycParty || {
        name: String(recipient.accountName || 'Customer'),
        country,
        phone: '+2348000000000',
        address: 'Lagos',
        dob: '1990-01-01',
        email: 'offramp@dayfi.test',
        idNumber: 'A00000000',
        idType: 'passport',
      }) as Record<string, unknown>;

      // Prefer lookup-by-sequence for idempotent retry.
      try {
        const existingPayment = await yc.fetchPaymentBySequenceId(sequenceId);
        if (existingPayment?.id || existingPayment?.sequenceId) {
          provider = existingPayment as Record<string, unknown>;
        } else {
          provider = (await yc.createPaymentRequest({
            sequenceId,
            channelId,
            currency,
            country,
            reason: String(meta.reason || 'other').toLowerCase(),
            amount: Number(input.payout.amount),
            forceAccept: true,
            destination: {
              accountNumber: String(recipient.accountNumber || '').trim(),
              accountType: destType,
              networkId: recipient.bankCode || recipient.networkId || meta.networkId,
              accountName: String(recipient.accountName || '').trim(),
            },
            recipient: ycParty as any,
          })) as Record<string, unknown>;
        }
      } catch {
        provider = (await yc.createPaymentRequest({
          sequenceId,
          channelId,
          currency,
          country,
          reason: String(meta.reason || 'other').toLowerCase(),
          amount: Number(input.payout.amount),
          forceAccept: true,
          destination: {
            accountNumber: String(recipient.accountNumber || '').trim(),
            accountType: destType,
            networkId: recipient.bankCode || recipient.networkId || meta.networkId,
            accountName: String(recipient.accountName || '').trim(),
          },
          recipient: ycParty as any,
        })) as Record<string, unknown>;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      await db.none(
        `UPDATE infra_settlements SET
           status = 'failed',
           failure_reason = $2,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [settlement.id, reason.slice(0, 500)]
      );
      await patchPayoutMeta(
        input.payout.id,
        {
          offRampPhase: 'provider_failed',
          providerRetryRequired: true,
          providerFailureReason: reason,
        },
        'processing'
      );
      throw new InfraFiatWithdrawalError(reason, 'PROVIDER_FAILED', 502);
    }
  }

  const providerRef = String(
    provider.id || provider.paymentId || provider.sequenceId || sequenceId
  );

  await db.none(
    `UPDATE infra_settlements SET
       status = 'submitted',
       external_reference = $2,
       provider_reference = $2,
       submitted_at = CURRENT_TIMESTAMP,
       rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $3::jsonb,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      settlement.id,
      providerRef,
      JSON.stringify({
        provider,
        sequenceId,
        simulated: provider.simulated === true,
      }),
    ]
  );

  await patchPayoutMeta(input.payout.id, {
    provider,
    providerReference: providerRef,
    railSubmittedAt: new Date().toISOString(),
  });

  // Mock/test: confirm provider immediately (no real bank rail).
  if (mode === 'mock' || env === 'test' || provider.simulated === true) {
    await db.none(
      `UPDATE infra_settlements SET
         status = 'confirmed',
         confirmed_at = CURRENT_TIMESTAMP,
         failure_reason = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [settlement.id]
    );
    await finalizePayoutDebit({
      orgId: input.orgId,
      transactionId: input.payout.id,
      providerEventId: `offramp:provider:${providerRef}`,
      source: 'fiat_offramp_provider',
    });
    await patchPayoutMeta(input.payout.id, {
      offRampPhase: 'completed',
      providerRetryRequired: false,
      providerConfirmed: true,
      settlementRail: 'PROVIDER',
    });
  }

  return (await loadSettlementByKey(input.orgId, providerIdem))!;
}

/**
 * Execute Increment H after funds are locked:
 * Stellar Alice→treasury → confirm → Provider payout.
 */
export async function settleFiatOfframp(input: {
  orgId: string;
  payoutTransactionId: string;
}) {
  if (!isFiatOfframpEnabled()) {
    throw new InfraFiatWithdrawalError(
      'Fiat offramp mode is off (set DAYFI_INFRA_FIAT_OFFRAMP_MODE=mock|live)',
      'OFFRAMP_DISABLED',
      409
    );
  }

  const payout = await loadPayout(input.orgId, input.payoutTransactionId);
  const meta = payout.metadata || {};
  if (!['bank_transfer', 'mobile_money'].includes(String(payout.method))) {
    throw new InfraFiatWithdrawalError(
      'Only bank/momo payouts support fiat offramp',
      'UNSUPPORTED_METHOD',
      400
    );
  }

  const locked =
    Boolean(meta.ledgerLockId) ||
    meta.fundsLocked === true ||
    (typeof meta.usdcAmount === 'number' &&
      meta.usdcAmount > 0 &&
      !meta.fundsReleased);
  if (!locked && meta.fundsFinalized !== true) {
    throw new InfraFiatWithdrawalError(
      'Payout funds are not locked',
      'NOT_LOCKED',
      409
    );
  }

  if (meta.fundsFinalized === true || String(payout.status).toLowerCase() === 'settled') {
    const stellar = await loadSettlementByRail(payout.id, 'STELLAR');
    const provider = await loadSettlementByRail(payout.id, 'YELLOW_CARD');
    return {
      payoutId: payout.id,
      status: 'completed',
      offRampPhase: 'completed',
      stellar: stellar ? mapSettlement(stellar) : null,
      provider: provider ? mapSettlement(provider) : null,
      balance: await getOrgBalance(input.orgId, asEnv(payout.environment)),
      duplicate: true,
    };
  }

  const usdcAmount = usdcAmountFromPayout(payout);

  let stellar = await loadSettlementByRail(payout.id, 'STELLAR');
  if (!stellar || stellar.status !== 'confirmed') {
    stellar = await settleStellarToTreasury({
      orgId: input.orgId,
      payout: await loadPayout(input.orgId, payout.id),
      usdcAmount,
    });
  }

  let provider: SettlementRow | null = null;
  try {
    provider = await submitProviderPayout({
      orgId: input.orgId,
      payout: await loadPayout(input.orgId, payout.id),
      usdcAmount,
    });
  } catch (err) {
    if (
      err instanceof InfraFiatWithdrawalError &&
      err.code === 'PROVIDER_FAILED'
    ) {
      stellar = (await loadSettlementByRail(payout.id, 'STELLAR')) || stellar;
      provider = await loadSettlementByRail(payout.id, 'YELLOW_CARD');
      return {
        payoutId: payout.id,
        status: 'provider_retry_required',
        offRampPhase: 'provider_failed',
        stellar: stellar ? mapSettlement(stellar) : null,
        provider: provider ? mapSettlement(provider) : null,
        balance: await getOrgBalance(input.orgId, asEnv(payout.environment)),
        providerRetryRequired: true,
        error: err.message,
      };
    }
    throw err;
  }

  const refreshed = await loadPayout(input.orgId, payout.id);
  return {
    payoutId: payout.id,
    status:
      String(refreshed.status).toLowerCase() === 'settled'
        ? 'completed'
        : 'provider_submitted',
    offRampPhase: (refreshed.metadata || {}).offRampPhase || 'provider_submitted',
    stellar: mapSettlement(stellar),
    provider: provider ? mapSettlement(provider) : null,
    balance: await getOrgBalance(input.orgId, asEnv(payout.environment)),
    providerRetryRequired: false,
  };
}

/** Idempotent Provider retry after Stellar already confirmed. */
export async function retryFiatOfframpProvider(input: {
  orgId: string;
  payoutTransactionId: string;
}) {
  const payout = await loadPayout(input.orgId, input.payoutTransactionId);
  const meta = payout.metadata || {};
  if (meta.stellarConfirmed !== true) {
    throw new InfraFiatWithdrawalError(
      'Cannot retry Provider before Stellar treasury receipt is confirmed',
      'STELLAR_NOT_CONFIRMED',
      409
    );
  }
  if (meta.fundsFinalized === true) {
    const stellar = await loadSettlementByRail(payout.id, 'STELLAR');
    const provider = await loadSettlementByRail(payout.id, 'YELLOW_CARD');
    return {
      payoutId: payout.id,
      status: 'completed',
      offRampPhase: 'completed',
      stellar: stellar ? mapSettlement(stellar) : null,
      provider: provider ? mapSettlement(provider) : null,
      balance: await getOrgBalance(input.orgId, asEnv(payout.environment)),
      duplicate: true,
    };
  }

  // Reset failed provider settlement to allow re-submit with same idempotency key path.
  const providerIdem = `provider:offramp:${payout.id}`;
  const failed = await loadSettlementByKey(input.orgId, providerIdem);
  if (failed && failed.status === 'failed') {
    await db.none(
      `UPDATE infra_settlements SET
         status = 'pending',
         failure_reason = NULL,
         external_reference = NULL,
         provider_reference = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [failed.id]
    );
  }

  // Clear force-fail only for this retry attempt when explicitly allowed by caller env.
  // Tests unset DAYFI_INFRA_OFFRAMP_FORCE_PROVIDER_FAIL before calling retry.
  return settleFiatOfframp(input);
}

/**
 * Webhook helper: Provider failure after treasury receipt must not unlock Alice.
 */
export function shouldRetainTreasuryOnProviderFailure(meta: Record<string, unknown>): boolean {
  return meta.offRamp === true && meta.stellarConfirmed === true;
}
