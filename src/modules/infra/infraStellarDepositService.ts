/**
 * Increment D — External Stellar USDC deposits into org Dayfi wallets.
 *
 * External wallet → REAL USDC → org Stellar wallet → verify → pending → available.
 *
 * Never credits available from a notification alone.
 * Idempotency: deposit:{stellarTxHash}
 *
 * Modes (DAYFI_INFRA_STELLAR_DEPOSIT_MODE):
 *   off  — default; no polling/credit
 *   mock — CI: accept caller-supplied verified payment facts
 *   live — Horizon poll + independent verification (Testnet-first)
 */

import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import {
  creditOrgWalletPending,
  getOrgBalance,
  releasePendingToAvailable,
  type InfraEnvironment,
} from './infraLedgerService';
import {
  findOrgStellarAccountByPublicKey,
  getOrgStellarAccount,
  listActiveOrgStellarAccounts,
  type InfraStellarAccountView,
} from './infraStellarAccountService';

export type InfraStellarDepositMode = 'off' | 'mock' | 'live';
export type DepositStatus =
  | 'detected'
  | 'verified'
  | 'pending_ledger'
  | 'confirmed'
  | 'rejected'
  | 'failed';

export class InfraStellarDepositError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraStellarDepositError';
    this.code = code;
    this.status = status;
  }
}

export type VerifiedDepositPayment = {
  stellarTxHash: string;
  sourcePublicKey: string | null;
  destinationPublicKey: string;
  amount: number;
  asset: 'USDC';
  assetIssuer: string;
  network: 'testnet' | 'mainnet';
  successful: boolean;
  ledgerSequence: number | null;
  operationId: string | null;
};

type DepositRow = {
  id: string;
  org_id: string;
  environment: string;
  stellar_account_id: string | null;
  transaction_id: string | null;
  stellar_tx_hash: string;
  source_public_key: string | null;
  destination_public_key: string;
  asset: string;
  asset_issuer: string;
  amount: string;
  network: string;
  status: string;
  ledger_pending_movement_id: string | null;
  ledger_available_movement_id: string | null;
  failure_reason: string | null;
  idempotency_key: string;
  detected_at: Date;
  verified_at: Date | null;
  confirmed_at: Date | null;
  metadata: Record<string, unknown> | null;
};

const DEPOSIT_SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment,
  stellar_account_id::text AS stellar_account_id,
  transaction_id::text AS transaction_id, stellar_tx_hash,
  source_public_key, destination_public_key, asset, asset_issuer,
  amount::text, network, status,
  ledger_pending_movement_id::text AS ledger_pending_movement_id,
  ledger_available_movement_id::text AS ledger_available_movement_id,
  failure_reason, idempotency_key, detected_at, verified_at, confirmed_at, metadata
 FROM infra_stellar_deposits`;

export function getInfraStellarDepositMode(): InfraStellarDepositMode {
  const raw = String(process.env.DAYFI_INFRA_STELLAR_DEPOSIT_MODE || 'off')
    .trim()
    .toLowerCase();
  if (raw === 'mock' || raw === 'live' || raw === 'off') return raw;
  return 'off';
}

function depositIdempotencyKey(hash: string): string {
  return `deposit:${String(hash).trim().toLowerCase()}`;
}

function asEnv(env: string): InfraEnvironment {
  return env === 'live' ? 'live' : 'test';
}

function mapDeposit(row: DepositRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment as InfraEnvironment,
    stellarAccountId: row.stellar_account_id,
    transactionId: row.transaction_id,
    stellarTxHash: row.stellar_tx_hash,
    sourcePublicKey: row.source_public_key,
    destinationPublicKey: row.destination_public_key,
    asset: row.asset,
    assetIssuer: row.asset_issuer,
    amount: Number(row.amount),
    network: row.network as 'testnet' | 'mainnet',
    status: row.status as DepositStatus,
    ledgerPendingMovementId: row.ledger_pending_movement_id,
    ledgerAvailableMovementId: row.ledger_available_movement_id,
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    detectedAt: row.detected_at,
    verifiedAt: row.verified_at,
    confirmedAt: row.confirmed_at,
    metadata: row.metadata || {},
  };
}

export type InfraStellarDepositView = ReturnType<typeof mapDeposit>;

/**
 * Independently verify a classic USDC payment on Horizon.
 * Does not credit the ledger.
 */
export async function verifyExternalUsdcDeposit(input: {
  stellarTxHash: string;
  expectedDestination?: string;
  expectedAmount?: number;
  expectedNetwork?: 'testnet' | 'mainnet';
}): Promise<VerifiedDepositPayment> {
  const hash = String(input.stellarTxHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new InfraStellarDepositError(
      'Invalid Stellar transaction hash',
      'INVALID_HASH'
    );
  }

  const cfg = getStellarConfig();
  const expectedNetwork = input.expectedNetwork || (cfg.isTestnet ? 'testnet' : 'mainnet');
  if (cfg.isTestnet !== (expectedNetwork === 'testnet')) {
    throw new InfraStellarDepositError(
      `Network mismatch: config is ${cfg.isTestnet ? 'testnet' : 'mainnet'}, expected ${expectedNetwork}`,
      'UNSUPPORTED_NETWORK',
      400
    );
  }

  if (!cfg.isTestnet && getInfraStellarDepositMode() === 'live') {
    throw new InfraStellarDepositError(
      'Live deposit processing is Testnet-only in Increment D',
      'MAINNET_BLOCKED',
      400
    );
  }

  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  let tx: Awaited<ReturnType<ReturnType<typeof server.transactions>['transaction']>>;
  try {
    tx = await server.transactions().transaction(hash).call();
  } catch {
    throw new InfraStellarDepositError(
      'Stellar transaction not found on Horizon',
      'TX_NOT_FOUND',
      404
    );
  }

  if (!tx.successful) {
    throw new InfraStellarDepositError(
      'Stellar transaction did not succeed',
      'TX_FAILED',
      400
    );
  }

  const ops = await server.operations().forTransaction(hash).call();
  const issuer = resolveUsdcIssuer(cfg.isTestnet);
  const payment = ops.records.find((op: Record<string, unknown>) => {
    if (op.type !== 'payment') return false;
    if (String(op.asset_code || '').toUpperCase() !== 'USDC') return false;
    if (String(op.asset_issuer || '') !== issuer) return false;
    return true;
  }) as Record<string, unknown> | undefined;

  if (!payment) {
    throw new InfraStellarDepositError(
      'No USDC payment operation with expected issuer found',
      'WRONG_ASSET',
      400
    );
  }

  const destination = String(payment.to || '').trim();
  const source = String(payment.from || '').trim() || null;
  const amount = Math.round(Number(payment.amount) * 1e7) / 1e7;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InfraStellarDepositError('Invalid payment amount', 'INVALID_AMOUNT');
  }

  if (input.expectedDestination && destination !== input.expectedDestination) {
    throw new InfraStellarDepositError(
      'Destination does not match organization Stellar wallet',
      'WRONG_DESTINATION',
      400
    );
  }

  if (
    input.expectedAmount != null &&
    Math.abs(amount - Number(input.expectedAmount)) > 1e-7
  ) {
    throw new InfraStellarDepositError(
      `Amount mismatch (on-chain ${amount}, expected ${input.expectedAmount})`,
      'AMOUNT_MISMATCH',
      400
    );
  }

  return {
    stellarTxHash: hash,
    sourcePublicKey: source,
    destinationPublicKey: destination,
    amount,
    asset: 'USDC',
    assetIssuer: issuer,
    network: cfg.isTestnet ? 'testnet' : 'mainnet',
    successful: true,
    ledgerSequence: typeof tx.ledger_attr === 'number' ? tx.ledger_attr : null,
    operationId: payment.id ? String(payment.id) : null,
  };
}

export async function getDepositByHash(
  stellarTxHash: string
): Promise<InfraStellarDepositView | null> {
  const hash = String(stellarTxHash || '').trim().toLowerCase();
  const row = await db.oneOrNone<DepositRow>(
    `${DEPOSIT_SELECT} WHERE stellar_tx_hash = $1`,
    [hash]
  );
  return row ? mapDeposit(row) : null;
}

export async function getDepositByTransactionId(
  transactionId: string
): Promise<InfraStellarDepositView | null> {
  const row = await db.oneOrNone<DepositRow>(
    `${DEPOSIT_SELECT} WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [transactionId]
  );
  return row ? mapDeposit(row) : null;
}

async function ensureDepositTransaction(input: {
  orgId: string;
  environment: InfraEnvironment;
  amount: number;
  hash: string;
  source: string | null;
  destination: string;
  depositId: string;
}): Promise<string> {
  const existing = await db.oneOrNone<{ id: string }>(
    `SELECT id::text AS id FROM infra_transactions
     WHERE org_id = $1 AND environment = $2
       AND metadata->>'stellarTxHash' = $3
       AND metadata->>'type' = 'stellar_deposit'
     LIMIT 1`,
    [input.orgId, input.environment, input.hash]
  );
  if (existing) return existing.id;

  const row = await db.one<{ id: string }>(
    `INSERT INTO infra_transactions
       (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
     VALUES ($1, $2, $3, 'USDC', 'processing', 'crypto', 'deposit', 0, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [
      input.orgId,
      input.environment,
      input.amount,
      `stellar-deposit:${input.hash}`,
      JSON.stringify({
        type: 'stellar_deposit',
        usdcAmount: input.amount,
        stellarTxHash: input.hash,
        sourcePublicKey: input.source,
        destinationPublicKey: input.destination,
        settlementRail: 'STELLAR',
        depositId: input.depositId,
        ledgerPhase: 'pending',
      }),
    ]
  );
  return row.id;
}

/**
 * After independent verification: credit pending, then release to available.
 * Same hash never credits twice.
 */
export async function creditVerifiedDeposit(input: {
  verified: VerifiedDepositPayment;
  orgAccount?: InfraStellarAccountView | null;
  stopAfterPending?: boolean;
}): Promise<{
  deposit: InfraStellarDepositView;
  ledgerPhase: 'pending' | 'available';
  balance: Awaited<ReturnType<typeof getOrgBalance>>;
  duplicate: boolean;
}> {
  const v = input.verified;
  const key = depositIdempotencyKey(v.stellarTxHash);

  let existing = await getDepositByHash(v.stellarTxHash);
  if (existing?.status === 'confirmed') {
    const balance = await getOrgBalance(existing.orgId, existing.environment);
    return {
      deposit: existing,
      ledgerPhase: 'available',
      balance,
      duplicate: true,
    };
  }

  const orgAccount =
    input.orgAccount ||
    (await findOrgStellarAccountByPublicKey(v.destinationPublicKey));
  if (!orgAccount) {
    throw new InfraStellarDepositError(
      'Destination is not a Dayfi organization Stellar wallet',
      'UNKNOWN_DESTINATION',
      404
    );
  }
  if (orgAccount.status !== 'active') {
    throw new InfraStellarDepositError(
      `Organization Stellar wallet is not active (${orgAccount.status})`,
      'WALLET_NOT_ACTIVE',
      409
    );
  }
  if (orgAccount.publicKey !== v.destinationPublicKey) {
    throw new InfraStellarDepositError(
      'Destination mismatch after org lookup',
      'WRONG_DESTINATION',
      400
    );
  }

  const env = asEnv(orgAccount.environment);

  if (!existing) {
    try {
      const row = await db.one<DepositRow>(
        `INSERT INTO infra_stellar_deposits
           (org_id, environment, stellar_account_id, stellar_tx_hash,
            source_public_key, destination_public_key, asset, asset_issuer,
            amount, network, status, idempotency_key, verified_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'USDC', $7, $8, $9, 'verified', $10, CURRENT_TIMESTAMP, $11::jsonb)
         RETURNING id::text AS id, org_id::text AS org_id, environment,
                   stellar_account_id::text AS stellar_account_id,
                   transaction_id::text AS transaction_id, stellar_tx_hash,
                   source_public_key, destination_public_key, asset, asset_issuer,
                   amount::text, network, status,
                   ledger_pending_movement_id::text AS ledger_pending_movement_id,
                   ledger_available_movement_id::text AS ledger_available_movement_id,
                   failure_reason, idempotency_key, detected_at, verified_at, confirmed_at, metadata`,
        [
          orgAccount.orgId,
          env,
          orgAccount.id,
          v.stellarTxHash,
          v.sourcePublicKey,
          v.destinationPublicKey,
          v.assetIssuer,
          v.amount,
          v.network,
          key,
          JSON.stringify({
            ledgerSequence: v.ledgerSequence,
            operationId: v.operationId,
            verifiedIndependently: true,
          }),
        ]
      );
      existing = mapDeposit(row);
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      if (code === '23505') {
        existing = await getDepositByHash(v.stellarTxHash);
      } else {
        throw err;
      }
    }
  }

  if (!existing) {
    throw new InfraStellarDepositError(
      'Failed to create deposit record',
      'DEPOSIT_CREATE_FAILED',
      500
    );
  }

  if (existing.status === 'rejected' || existing.status === 'failed') {
    throw new InfraStellarDepositError(
      existing.failureReason || 'Deposit previously rejected',
      'DEPOSIT_REJECTED',
      409
    );
  }

  const txId =
    existing.transactionId ||
    (await ensureDepositTransaction({
      orgId: orgAccount.orgId,
      environment: env,
      amount: v.amount,
      hash: v.stellarTxHash,
      source: v.sourcePublicKey,
      destination: v.destinationPublicKey,
      depositId: existing.id,
    }));

  if (!existing.transactionId) {
    await db.none(
      `UPDATE infra_stellar_deposits
       SET transaction_id = $2, status = 'pending_ledger', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [existing.id, txId]
    );
  }

  const pending = await creditOrgWalletPending({
    orgId: orgAccount.orgId,
    environment: env,
    amount: v.amount,
    idempotencyKey: `deposit:${v.stellarTxHash}:pending`,
    movementType: 'deposit_pending',
    referenceType: 'deposit',
    referenceId: txId,
    reference: v.stellarTxHash,
    metadata: {
      stellarTxHash: v.stellarTxHash,
      depositId: existing.id,
      ledgerPhase: 'pending',
      sourcePublicKey: v.sourcePublicKey,
    },
  });

  await db.none(
    `UPDATE infra_stellar_deposits
     SET ledger_pending_movement_id = COALESCE(ledger_pending_movement_id, $2),
         transaction_id = COALESCE(transaction_id, $3),
         status = CASE WHEN status = 'confirmed' THEN status ELSE 'pending_ledger' END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [existing.id, pending.id, txId]
  );

  if (input.stopAfterPending) {
    const balance = await getOrgBalance(orgAccount.orgId, env);
    const deposit = (await getDepositByHash(v.stellarTxHash))!;
    return { deposit, ledgerPhase: 'pending', balance, duplicate: pending.duplicate === true };
  }

  const available = await releasePendingToAvailable({
    orgId: orgAccount.orgId,
    environment: env,
    amount: v.amount,
    idempotencyKey: `deposit:${v.stellarTxHash}:available`,
    movementType: 'deposit_credit',
    referenceType: 'deposit',
    referenceId: txId,
    reference: v.stellarTxHash,
    metadata: {
      stellarTxHash: v.stellarTxHash,
      depositId: existing.id,
      ledgerPhase: 'available',
      sourcePublicKey: v.sourcePublicKey,
    },
  });

  await db.none(
    `UPDATE infra_stellar_deposits SET
       status = 'confirmed',
       ledger_available_movement_id = COALESCE(ledger_available_movement_id, $2),
       confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [existing.id, available.id]
  );

  await db.none(
    `UPDATE infra_transactions SET
       status = 'settled',
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [
      txId,
      JSON.stringify({
        settledAt: new Date().toISOString(),
        ledgerPhase: 'available',
        stellarTxHash: v.stellarTxHash,
        depositId: existing.id,
      }),
    ]
  );

  const deposit = (await getDepositByHash(v.stellarTxHash))!;
  const balance = await getOrgBalance(orgAccount.orgId, env);
  return {
    deposit,
    ledgerPhase: 'available',
    balance,
    duplicate: pending.duplicate === true && available.duplicate === true,
  };
}

/**
 * Verify hash independently, then credit (pending → available).
 */
export async function processExternalDepositByHash(input: {
  stellarTxHash: string;
  expectedDestination?: string;
  expectedAmount?: number;
  stopAfterPending?: boolean;
  /** Mock mode only: skip Horizon and use supplied facts */
  mockPayment?: VerifiedDepositPayment;
}): Promise<{
  deposit: InfraStellarDepositView;
  ledgerPhase: 'pending' | 'available';
  balance: Awaited<ReturnType<typeof getOrgBalance>>;
  duplicate: boolean;
  verified: VerifiedDepositPayment;
}> {
  const mode = getInfraStellarDepositMode();
  if (mode === 'off') {
    throw new InfraStellarDepositError(
      'Stellar deposit mode is off',
      'DEPOSIT_MODE_OFF',
      400
    );
  }

  let verified: VerifiedDepositPayment;
  if (mode === 'mock' && input.mockPayment) {
    verified = input.mockPayment;
  } else {
    verified = await verifyExternalUsdcDeposit({
      stellarTxHash: input.stellarTxHash,
      expectedDestination: input.expectedDestination,
      expectedAmount: input.expectedAmount,
    });
  }

  const result = await creditVerifiedDeposit({
    verified,
    stopAfterPending: input.stopAfterPending,
  });
  return { ...result, verified };
}

/**
 * Poll Horizon for inbound USDC payments to an org wallet and process them.
 */
export async function pollOrgStellarDeposits(input: {
  orgId: string;
  environment: InfraEnvironment | string;
  limit?: number;
}): Promise<{
  scanned: number;
  processed: number;
  credited: number;
  duplicates: number;
  skipped: number;
  errors: string[];
  deposits: InfraStellarDepositView[];
}> {
  const mode = getInfraStellarDepositMode();
  const result = {
    scanned: 0,
    processed: 0,
    credited: 0,
    duplicates: 0,
    skipped: 0,
    errors: [] as string[],
    deposits: [] as InfraStellarDepositView[],
  };

  if (mode === 'off') {
    result.errors.push('deposit_mode_off');
    return result;
  }

  const env = asEnv(String(input.environment));
  const account = await getOrgStellarAccount(input.orgId, env);
  if (!account || account.status !== 'active') {
    result.errors.push('org_wallet_not_active');
    return result;
  }

  if (mode === 'mock') {
    result.errors.push('mock_mode_requires_processExternalDepositByHash');
    return result;
  }

  const cfg = getStellarConfig();
  if (!cfg.isTestnet) {
    throw new InfraStellarDepositError(
      'Live deposit polling is Testnet-only in Increment D',
      'MAINNET_BLOCKED',
      400
    );
  }

  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const issuer = resolveUsdcIssuer(true);
  const page = await server
    .payments()
    .forAccount(account.publicKey)
    .limit(Math.min(input.limit || 50, 200))
    .order('desc')
    .call();

  for (const rec of page.records as Record<string, unknown>[]) {
    result.scanned += 1;
    if (rec.type !== 'payment') {
      result.skipped += 1;
      continue;
    }
    if (String(rec.to || '') !== account.publicKey) {
      result.skipped += 1;
      continue;
    }
    if (String(rec.from || '') === account.publicKey) {
      result.skipped += 1;
      continue;
    }
    if (String(rec.asset_code || '').toUpperCase() !== 'USDC') {
      result.skipped += 1;
      continue;
    }
    if (String(rec.asset_issuer || '') !== issuer) {
      result.skipped += 1;
      continue;
    }

    const hash = String(rec.transaction_hash || '').toLowerCase();
    if (!hash) {
      result.skipped += 1;
      continue;
    }

    try {
      const processed = await processExternalDepositByHash({
        stellarTxHash: hash,
        expectedDestination: account.publicKey,
      });
      result.processed += 1;
      result.deposits.push(processed.deposit);
      if (processed.duplicate) result.duplicates += 1;
      else if (processed.ledgerPhase === 'available') result.credited += 1;
    } catch (err: unknown) {
      result.errors.push(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return result;
}

export async function pollAllActiveOrgDeposits(input?: {
  environment?: InfraEnvironment | string;
}): Promise<{
  orgs: number;
  totals: Awaited<ReturnType<typeof pollOrgStellarDeposits>>;
}> {
  const accounts = await listActiveOrgStellarAccounts({
    environment: input?.environment,
  });
  const totals = {
    scanned: 0,
    processed: 0,
    credited: 0,
    duplicates: 0,
    skipped: 0,
    errors: [] as string[],
    deposits: [] as InfraStellarDepositView[],
  };
  for (const acct of accounts) {
    const r = await pollOrgStellarDeposits({
      orgId: acct.orgId,
      environment: acct.environment,
    });
    totals.scanned += r.scanned;
    totals.processed += r.processed;
    totals.credited += r.credited;
    totals.duplicates += r.duplicates;
    totals.skipped += r.skipped;
    totals.errors.push(...r.errors);
    totals.deposits.push(...r.deposits);
  }
  return { orgs: accounts.length, totals };
}
