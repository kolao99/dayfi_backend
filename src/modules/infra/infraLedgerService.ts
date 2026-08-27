/**
 * Dayfi Infrastructure ledger (Phase 1–2).
 *
 * Design rule: the Dayfi ledger is the financial source of truth.
 * Collect credits only on verified settlement events.
 * Send locks funds first, then finalizes or releases — never invents money.
 * Stellar settlement is deferred to a later phase.
 */

import { db } from '../../config/database';

export type InfraEnvironment = 'test' | 'live';
export type InfraAsset = 'USDC';
export type LedgerDirection = 'credit' | 'debit';

export const DEFAULT_INFRA_ASSET: InfraAsset = 'USDC';

export class InfraLedgerError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraLedgerError';
    this.code = code;
    this.status = status;
  }
}

export type InfraWalletAccount = {
  id: string;
  org_id: string;
  environment: InfraEnvironment;
  asset: string;
  status: string;
  available: string;
  pending: string;
  locked: string;
  created_at: Date;
  updated_at: Date;
};

export type InfraLedgerMovement = {
  id: string;
  wallet_account_id: string;
  org_id: string;
  environment: InfraEnvironment;
  direction: LedgerDirection;
  amount: string;
  asset: string;
  movement_type: string;
  reference: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  available_after: string;
  pending_after: string;
  locked_after: string;
  created_at: Date;
  duplicate?: boolean;
};

export type LedgerWriteParams = {
  orgId: string;
  environment: InfraEnvironment | string;
  amount: number | string;
  asset?: string;
  idempotencyKey: string;
  movementType?: string;
  reference?: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
};

export type InfraBalanceView = {
  orgId: string;
  environment: InfraEnvironment;
  asset: string;
  status: string;
  available: number;
  pending: number;
  locked: number;
  walletAccountId: string;
};

export type InfraLedgerTx = {
  one: <T = any>(query: string, values?: any[]) => Promise<T>;
  oneOrNone: <T = any>(query: string, values?: any[]) => Promise<T | null>;
  none: (query: string, values?: any[]) => Promise<null>;
};

function parseAmount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InfraLedgerError('Amount must be a positive number', 'INVALID_AMOUNT');
  }
  // Cap precision noise for USDC-style amounts (7 dp max).
  return Math.round(n * 1e7) / 1e7;
}

function toNumber(raw: string | number): number {
  return Math.round(Number(raw) * 1e7) / 1e7;
}

function normalizeEnv(env: string): InfraEnvironment {
  return env === 'live' ? 'live' : 'test';
}

function normalizeAsset(asset?: string): string {
  return String(asset || DEFAULT_INFRA_ASSET).trim().toUpperCase() || DEFAULT_INFRA_ASSET;
}

function mapBalance(row: InfraWalletAccount): InfraBalanceView {
  return {
    orgId: row.org_id,
    environment: row.environment,
    asset: row.asset,
    status: row.status,
    available: toNumber(row.available),
    pending: toNumber(row.pending),
    locked: toNumber(row.locked),
    walletAccountId: row.id,
  };
}

async function findMovementByIdempotency(
  t: InfraLedgerTx,
  idempotencyKey: string
): Promise<InfraLedgerMovement | null> {
  return t.oneOrNone<InfraLedgerMovement>(
    `SELECT id, wallet_account_id, org_id, environment, direction, amount::text, asset,
            movement_type, reference, reference_type, reference_id, idempotency_key, metadata,
            available_after::text, pending_after::text, locked_after::text, created_at
     FROM infra_ledger_movements
     WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
}

const MOVEMENT_RETURNING = `id, wallet_account_id, org_id, environment, direction, amount::text, asset,
                   movement_type, reference, reference_type, reference_id, idempotency_key, metadata,
                   available_after::text, pending_after::text, locked_after::text, created_at`;

async function lockWalletRow(t: InfraLedgerTx, walletId: string): Promise<InfraWalletAccount> {
  return t.one<InfraWalletAccount>(
    `SELECT id, org_id, environment, asset, status,
            available::text, pending::text, locked::text, created_at, updated_at
     FROM infra_wallet_accounts
     WHERE id = $1
     FOR UPDATE`,
    [walletId]
  );
}

async function insertMovement(
  t: InfraLedgerTx,
  args: {
    wallet: InfraWalletAccount;
    direction: LedgerDirection;
    amount: number;
    movementType: string;
    reference: string | null;
    referenceType: string | null;
    referenceId: string | null;
    idempotencyKey: string;
    metadata: Record<string, unknown>;
    availableAfter: number;
    pendingAfter: number;
    lockedAfter: number;
  }
): Promise<InfraLedgerMovement> {
  return t.one<InfraLedgerMovement>(
    `INSERT INTO infra_ledger_movements (
       wallet_account_id, org_id, environment, direction, amount, asset,
       movement_type, reference, reference_type, reference_id, idempotency_key, metadata,
       available_after, pending_after, locked_after
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12::jsonb,
       $13, $14, $15
     )
     RETURNING ${MOVEMENT_RETURNING}`,
    [
      args.wallet.id,
      args.wallet.org_id,
      args.wallet.environment,
      args.direction,
      args.amount,
      args.wallet.asset,
      args.movementType,
      args.reference,
      args.referenceType,
      args.referenceId,
      args.idempotencyKey,
      JSON.stringify(args.metadata),
      args.availableAfter,
      args.pendingAfter,
      args.lockedAfter,
    ]
  );
}

/**
 * Ensure a wallet account exists for org + environment + asset.
 * LIVE accounts are created lazily when first accessed (after LIVE KYC gate).
 */
export async function ensureWalletAccount(
  orgId: string,
  environment: InfraEnvironment | string,
  asset: string = DEFAULT_INFRA_ASSET,
  t: InfraLedgerTx = db as unknown as InfraLedgerTx
): Promise<InfraWalletAccount> {
  const env = normalizeEnv(environment);
  const assetCode = normalizeAsset(asset);

  const existing = await t.oneOrNone<InfraWalletAccount>(
    `SELECT id, org_id, environment, asset, status,
            available::text, pending::text, locked::text, created_at, updated_at
     FROM infra_wallet_accounts
     WHERE org_id = $1 AND environment = $2 AND asset = $3`,
    [orgId, env, assetCode]
  );
  if (existing) return existing;

  return t.one<InfraWalletAccount>(
    `INSERT INTO infra_wallet_accounts (org_id, environment, asset, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (org_id, environment, asset) DO UPDATE
       SET updated_at = CURRENT_TIMESTAMP
     RETURNING id, org_id, environment, asset, status,
               available::text, pending::text, locked::text, created_at, updated_at`,
    [orgId, env, assetCode]
  );
}

/** Bootstrap TEST/USDC wallet when an organization is created. */
export async function bootstrapOrgWallets(orgId: string): Promise<InfraWalletAccount> {
  return ensureWalletAccount(orgId, 'test', DEFAULT_INFRA_ASSET);
}

export async function getOrgBalance(
  orgId: string,
  environment: InfraEnvironment | string,
  asset: string = DEFAULT_INFRA_ASSET
): Promise<InfraBalanceView> {
  const wallet = await ensureWalletAccount(orgId, environment, asset);
  if (wallet.status === 'closed') {
    throw new InfraLedgerError('Wallet account is closed', 'WALLET_CLOSED', 403);
  }
  return mapBalance(wallet);
}

export async function creditOrgWallet(params: {
  orgId: string;
  environment: InfraEnvironment | string;
  amount: number | string;
  asset?: string;
  idempotencyKey: string;
  movementType?: string;
  reference?: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const availableAfter = toNumber(row.available) + amount;
      const pendingAfter = toNumber(row.pending);
      const lockedAfter = toNumber(row.locked);

      await t.none(
        `UPDATE infra_wallet_accounts
         SET available = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, availableAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'credit',
        amount,
        movementType: params.movementType || 'adjustment',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

/**
 * Increment C — provider-confirmed collection entitlement held in pending
 * until Stellar wallet funding confirms (then pending → available).
 */
export async function creditOrgWalletPending(
  params: LedgerWriteParams
): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const availableAfter = toNumber(row.available);
      const pendingAfter = Math.round((toNumber(row.pending) + amount) * 1e7) / 1e7;
      const lockedAfter = toNumber(row.locked);

      await t.none(
        `UPDATE infra_wallet_accounts
         SET pending = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, pendingAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'credit',
        amount,
        movementType: params.movementType || 'collection_pending',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

/**
 * Increment C — Stellar wallet funding confirmed: move pending entitlement → available.
 */
export async function releasePendingToAvailable(
  params: LedgerWriteParams
): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const pendingBal = toNumber(row.pending);
      if (pendingBal < amount) {
        throw new InfraLedgerError(
          `Insufficient pending balance (have ${pendingBal}, need ${amount})`,
          'INSUFFICIENT_PENDING',
          400
        );
      }

      const availableAfter = Math.round((toNumber(row.available) + amount) * 1e7) / 1e7;
      const pendingAfter = Math.round((pendingBal - amount) * 1e7) / 1e7;
      const lockedAfter = toNumber(row.locked);

      await t.none(
        `UPDATE infra_wallet_accounts
         SET available = $2, pending = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, availableAfter, pendingAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'credit',
        amount,
        movementType: params.movementType || 'collection_credit',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
  );
}

export async function debitOrgWallet(params: {
  orgId: string;
  environment: InfraEnvironment | string;
  amount: number | string;
  asset?: string;
  idempotencyKey: string;
  movementType?: string;
  reference?: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const available = toNumber(row.available);
      if (available < amount) {
        throw new InfraLedgerError(
          `Insufficient available balance (have ${available}, need ${amount})`,
          'INSUFFICIENT_BALANCE',
          400
        );
      }

      const availableAfter = Math.round((available - amount) * 1e7) / 1e7;
      const pendingAfter = toNumber(row.pending);
      const lockedAfter = toNumber(row.locked);

      await t.none(
        `UPDATE infra_wallet_accounts
         SET available = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, availableAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'debit',
        amount,
        movementType: params.movementType || 'adjustment',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

/**
 * Phase 2 Send: move funds available → locked (reservation).
 * Does not leave the organization — only reserves for an in-flight payout.
 */
export async function lockOrgFunds(params: LedgerWriteParams): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const available = toNumber(row.available);
      if (available < amount) {
        throw new InfraLedgerError(
          `Insufficient available balance (have ${available}, need ${amount})`,
          'INSUFFICIENT_BALANCE',
          400
        );
      }

      const availableAfter = Math.round((available - amount) * 1e7) / 1e7;
      const pendingAfter = toNumber(row.pending);
      const lockedAfter = Math.round((toNumber(row.locked) + amount) * 1e7) / 1e7;

      await t.none(
        `UPDATE infra_wallet_accounts
         SET available = $2, locked = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, availableAfter, lockedAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'debit',
        amount,
        movementType: params.movementType || 'funds_lock',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

/**
 * Phase 2 Send failure: return locked funds to available.
 */
export async function releaseOrgFunds(params: LedgerWriteParams): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const lockedBal = toNumber(row.locked);
      if (lockedBal < amount) {
        throw new InfraLedgerError(
          `Insufficient locked balance (have ${lockedBal}, need ${amount})`,
          'INSUFFICIENT_LOCKED',
          400
        );
      }

      const availableAfter = Math.round((toNumber(row.available) + amount) * 1e7) / 1e7;
      const pendingAfter = toNumber(row.pending);
      const lockedAfter = Math.round((lockedBal - amount) * 1e7) / 1e7;

      await t.none(
        `UPDATE infra_wallet_accounts
         SET available = $2, locked = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, availableAfter, lockedAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'credit',
        amount,
        movementType: params.movementType || 'funds_release',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

/**
 * Phase 2 Send success: consume locked funds (permanent debit).
 * Available is unchanged; locked decreases.
 */
export async function finalizeLockedDebit(
  params: LedgerWriteParams
): Promise<InfraLedgerMovement> {
  const amount = parseAmount(params.amount);
  const key = String(params.idempotencyKey || '').trim();
  if (!key) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  try {
    return await db.tx(async (t) => {
      const existing = await findMovementByIdempotency(t, key);
      if (existing) return { ...existing, duplicate: true };

      const wallet = await ensureWalletAccount(
        params.orgId,
        params.environment,
        params.asset,
        t
      );
      if (wallet.status !== 'active') {
        throw new InfraLedgerError('Wallet is not active', 'WALLET_INACTIVE', 403);
      }

      const row = await lockWalletRow(t, wallet.id);
      const lockedBal = toNumber(row.locked);
      if (lockedBal < amount) {
        throw new InfraLedgerError(
          `Insufficient locked balance (have ${lockedBal}, need ${amount})`,
          'INSUFFICIENT_LOCKED',
          400
        );
      }

      const availableAfter = toNumber(row.available);
      const pendingAfter = toNumber(row.pending);
      const lockedAfter = Math.round((lockedBal - amount) * 1e7) / 1e7;

      await t.none(
        `UPDATE infra_wallet_accounts
         SET locked = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, lockedAfter]
      );

      const movement = await insertMovement(t, {
        wallet: row,
        direction: 'debit',
        amount,
        movementType: params.movementType || 'payout_settle',
        reference: params.reference || params.referenceId || null,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        idempotencyKey: key,
        metadata: params.metadata || {},
        availableAfter,
        pendingAfter,
        lockedAfter,
      });
      return { ...movement, duplicate: false };
    });
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const existing = await findMovementByIdempotency(db as unknown as InfraLedgerTx, key);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
}

export const INTERNAL_TRANSFER_DEBIT = 'internal_transfer_debit';
export const INTERNAL_TRANSFER_CREDIT = 'internal_transfer_credit';

/**
 * Increment E — atomic Dayfi-to-Dayfi available transfer.
 * Both legs commit in one database transaction (or neither does).
 * Does not create a Stellar payment, treasury movement, or provider event.
 */
export async function transferAvailableBalance(params: {
  senderOrgId: string;
  recipientOrgId: string;
  environment: InfraEnvironment | string;
  amount: number | string;
  asset?: string;
  transferGroupId: string;
  debitIdempotencyKey: string;
  creditIdempotencyKey: string;
  senderReferenceId: string;
  recipientReferenceId: string;
  metadata?: Record<string, unknown>;
  t?: InfraLedgerTx;
}): Promise<{
  debit: InfraLedgerMovement;
  credit: InfraLedgerMovement;
  duplicate: boolean;
}> {
  const run = async (t: InfraLedgerTx) => {
    const amount = parseAmount(params.amount);
    const debitKey = String(params.debitIdempotencyKey || '').trim();
    const creditKey = String(params.creditIdempotencyKey || '').trim();
    if (!debitKey || !creditKey) {
      throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
    }
    if (params.senderOrgId === params.recipientOrgId) {
      throw new InfraLedgerError(
        'Cannot transfer to the same organization',
        'SELF_TRANSFER',
        400
      );
    }

    const existingDebit = await findMovementByIdempotency(t, debitKey);
    const existingCredit = await findMovementByIdempotency(t, creditKey);
    if (existingDebit && existingCredit) {
      return { debit: existingDebit, credit: existingCredit, duplicate: true };
    }
    if (existingDebit || existingCredit) {
      throw new InfraLedgerError(
        'Internal transfer is in a partial ledger state',
        'TRANSFER_INCONSISTENT',
        409
      );
    }

    const senderWallet = await ensureWalletAccount(
      params.senderOrgId,
      params.environment,
      params.asset,
      t
    );
    const recipientWallet = await ensureWalletAccount(
      params.recipientOrgId,
      params.environment,
      params.asset,
      t
    );
    if (senderWallet.environment !== recipientWallet.environment) {
      throw new InfraLedgerError(
        'Cross-environment transfers are not allowed',
        'CROSS_ENVIRONMENT',
        400
      );
    }
    if (senderWallet.status !== 'active') {
      throw new InfraLedgerError('Sender wallet is not active', 'WALLET_INACTIVE', 403);
    }
    if (recipientWallet.status !== 'active') {
      throw new InfraLedgerError(
        'Recipient wallet is not active',
        'RECIPIENT_INACTIVE',
        400
      );
    }

    const orderedIds = [senderWallet.id, recipientWallet.id].sort();
    const lockedById = new Map<string, InfraWalletAccount>();
    for (const id of orderedIds) {
      lockedById.set(id, await lockWalletRow(t, id));
    }
    const senderRow = lockedById.get(senderWallet.id)!;
    const recipientRow = lockedById.get(recipientWallet.id)!;

    if (senderRow.status !== 'active') {
      throw new InfraLedgerError('Sender wallet is not active', 'WALLET_INACTIVE', 403);
    }
    if (recipientRow.status !== 'active') {
      throw new InfraLedgerError(
        'Recipient wallet is not active',
        'RECIPIENT_INACTIVE',
        400
      );
    }

    const senderAvailable = toNumber(senderRow.available);
    if (senderAvailable < amount) {
      throw new InfraLedgerError(
        `Insufficient available balance (have ${senderAvailable}, need ${amount})`,
        'INSUFFICIENT_BALANCE',
        400
      );
    }

    const senderAvailableAfter = Math.round((senderAvailable - amount) * 1e7) / 1e7;
    const recipientAvailableAfter =
      Math.round((toNumber(recipientRow.available) + amount) * 1e7) / 1e7;
    const senderPending = toNumber(senderRow.pending);
    const senderLocked = toNumber(senderRow.locked);
    const recipientPending = toNumber(recipientRow.pending);
    const recipientLocked = toNumber(recipientRow.locked);

    await t.none(
      `UPDATE infra_wallet_accounts
       SET available = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [senderRow.id, senderAvailableAfter]
    );
    await t.none(
      `UPDATE infra_wallet_accounts
       SET available = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [recipientRow.id, recipientAvailableAfter]
    );

    const sharedMeta = {
      ...(params.metadata || {}),
      transferGroupId: params.transferGroupId,
      rail: 'internal_transfer',
    };

    const debit = await insertMovement(t, {
      wallet: senderRow,
      direction: 'debit',
      amount,
      movementType: INTERNAL_TRANSFER_DEBIT,
      reference: params.transferGroupId,
      referenceType: 'internal_transfer',
      referenceId: params.senderReferenceId,
      idempotencyKey: debitKey,
      metadata: {
        ...sharedMeta,
        role: 'sender',
        counterpartyOrgId: params.recipientOrgId,
      },
      availableAfter: senderAvailableAfter,
      pendingAfter: senderPending,
      lockedAfter: senderLocked,
    });

    const credit = await insertMovement(t, {
      wallet: recipientRow,
      direction: 'credit',
      amount,
      movementType: INTERNAL_TRANSFER_CREDIT,
      reference: params.transferGroupId,
      referenceType: 'internal_transfer',
      referenceId: params.recipientReferenceId,
      idempotencyKey: creditKey,
      metadata: {
        ...sharedMeta,
        role: 'recipient',
        counterpartyOrgId: params.senderOrgId,
      },
      availableAfter: recipientAvailableAfter,
      pendingAfter: recipientPending,
      lockedAfter: recipientLocked,
    });

    return { debit, credit, duplicate: false };
  };

  try {
    if (params.t) return run(params.t);
    return db.tx(async (t) => run(t));
  } catch (err: unknown) {
    if (err instanceof InfraLedgerError) throw err;
    if (isUniqueViolation(err)) {
      const t = params.t || (db as unknown as InfraLedgerTx);
      const debit = await findMovementByIdempotency(t, params.debitIdempotencyKey);
      const credit = await findMovementByIdempotency(t, params.creditIdempotencyKey);
      if (debit && credit) return { debit, credit, duplicate: true };
    }
    throw err;
  }
}

export const FEE_DEBIT = 'fee_debit';
export const FEE_REVENUE = 'fee_revenue';

/**
 * Charge a Dayfi USDC transaction fee and credit platform fee revenue.
 * Runs inside the caller's database transaction.
 * Does not create a Stellar payment.
 */
export async function applyDayfiTransactionFee(params: {
  payerOrgId: string;
  revenueOrgId: string;
  environment: InfraEnvironment | string;
  amount: number | string;
  transferGroupId: string;
  payerReferenceId: string;
  revenueReferenceId: string;
  debitIdempotencyKey: string;
  creditIdempotencyKey: string;
  metadata?: Record<string, unknown>;
  t: InfraLedgerTx;
}): Promise<{
  debit: InfraLedgerMovement;
  credit: InfraLedgerMovement;
  duplicate: boolean;
} | null> {
  const amount = parseAmount(params.amount);
  if (amount <= 0) return null;

  const t = params.t;
  const debitKey = String(params.debitIdempotencyKey || '').trim();
  const creditKey = String(params.creditIdempotencyKey || '').trim();
  if (!debitKey || !creditKey) {
    throw new InfraLedgerError('idempotencyKey is required', 'IDEMPOTENCY_REQUIRED');
  }

  const existingDebit = await findMovementByIdempotency(t, debitKey);
  const existingCredit = await findMovementByIdempotency(t, creditKey);
  if (existingDebit && existingCredit) {
    return { debit: existingDebit, credit: existingCredit, duplicate: true };
  }

  const payerWallet = await ensureWalletAccount(
    params.payerOrgId,
    params.environment,
    DEFAULT_INFRA_ASSET,
    t
  );
  const revenueWallet = await ensureWalletAccount(
    params.revenueOrgId,
    params.environment,
    DEFAULT_INFRA_ASSET,
    t
  );
  if (payerWallet.status !== 'active') {
    throw new InfraLedgerError('Sender wallet is not active', 'WALLET_INACTIVE', 403);
  }
  if (revenueWallet.status !== 'active') {
    throw new InfraLedgerError('Fee revenue wallet is not active', 'WALLET_INACTIVE', 403);
  }

  const orderedIds = [payerWallet.id, revenueWallet.id].sort();
  const lockedById = new Map<string, InfraWalletAccount>();
  for (const id of orderedIds) {
    lockedById.set(id, await lockWalletRow(t, id));
  }
  const payerRow = lockedById.get(payerWallet.id)!;
  const revenueRow = lockedById.get(revenueWallet.id)!;

  const payerAvailable = toNumber(payerRow.available);
  if (payerAvailable < amount) {
    throw new InfraLedgerError(
      `Insufficient available balance for transfer + fee (have ${payerAvailable}, need ${amount})`,
      'INSUFFICIENT_BALANCE',
      400
    );
  }

  const payerAvailableAfter = Math.round((payerAvailable - amount) * 1e7) / 1e7;
  const revenueAvailableAfter =
    Math.round((toNumber(revenueRow.available) + amount) * 1e7) / 1e7;

  await t.none(
    `UPDATE infra_wallet_accounts
     SET available = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [payerRow.id, payerAvailableAfter]
  );
  await t.none(
    `UPDATE infra_wallet_accounts
     SET available = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [revenueRow.id, revenueAvailableAfter]
  );

  const shared = {
    ...(params.metadata || {}),
    transferGroupId: params.transferGroupId,
    feeType: 'DAYFI_TRANSACTION_FEE',
    feeCurrency: 'USDC',
  };

  const debit = await insertMovement(t, {
    wallet: payerRow,
    direction: 'debit',
    amount,
    movementType: FEE_DEBIT,
    reference: `fee:${params.transferGroupId}`,
    referenceType: 'transaction_fee',
    referenceId: params.payerReferenceId,
    idempotencyKey: debitKey,
    metadata: { ...shared, role: 'customer_fee' },
    availableAfter: payerAvailableAfter,
    pendingAfter: toNumber(payerRow.pending),
    lockedAfter: toNumber(payerRow.locked),
  });

  const credit = await insertMovement(t, {
    wallet: revenueRow,
    direction: 'credit',
    amount,
    movementType: FEE_REVENUE,
    reference: `fee:${params.transferGroupId}`,
    referenceType: 'transaction_fee',
    referenceId: params.revenueReferenceId,
    idempotencyKey: creditKey,
    metadata: { ...shared, role: 'fee_revenue' },
    availableAfter: revenueAvailableAfter,
    pendingAfter: toNumber(revenueRow.pending),
    lockedAfter: toNumber(revenueRow.locked),
  });

  return { debit, credit, duplicate: false };
}

