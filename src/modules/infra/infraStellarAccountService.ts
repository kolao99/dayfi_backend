/**
 * Increment B — Per-org Stellar account domain (TESTNET-FIRST).
 *
 * Ledger (infra_wallet_accounts) = entitlement.
 * Stellar account = on-chain custody address.
 * These are related but not the same object.
 *
 * Modes:
 *   mock — CI/unit: keys + ACTIVE without network (default)
 *   live — real Testnet: Friendbot XLM + USDC trustline
 *
 * Never fabricates Stellar payment hashes (funding in Increment C).
 */

import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import {
  getStellarCustodyProvider,
  StellarCustodyError,
} from './infraStellarCustody';

export type InfraEnv = 'test' | 'live';
export type StellarNetwork = 'testnet' | 'mainnet';
export type StellarAccountStatus =
  | 'provisioning'
  | 'xlm_ready'
  | 'trustline_ready'
  | 'active'
  | 'failed';

export class InfraStellarAccountError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraStellarAccountError';
    this.code = code;
    this.status = status;
  }
}

type AccountRow = {
  id: string;
  org_id: string;
  environment: string;
  public_key: string;
  network: string;
  asset: string;
  usdc_issuer: string | null;
  status: string;
  custody_ref: string;
  failure_reason: string | null;
  xlm_funded_at: Date | null;
  trustline_at: Date | null;
  activated_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment,
  public_key, network, asset, usdc_issuer, status, custody_ref::text AS custody_ref,
  failure_reason, xlm_funded_at, trustline_at, activated_at, metadata,
  created_at, updated_at
 FROM infra_stellar_accounts`;

const provisionLocks = new Map<string, Promise<unknown>>();

export function getInfraStellarProvisionMode(): 'mock' | 'live' {
  const raw = String(process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE || '')
    .trim()
    .toLowerCase();
  if (raw === 'live' || raw === 'mock') return raw;
  return 'mock';
}

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

function mapPublic(row: AccountRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment as InfraEnv,
    publicKey: row.public_key,
    network: row.network as StellarNetwork,
    asset: row.asset,
    usdcIssuer: row.usdc_issuer,
    status: row.status as StellarAccountStatus,
    failureReason: row.failure_reason,
    xlmFundedAt: row.xlm_funded_at,
    trustlineAt: row.trustline_at,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /** Explicit: secrets never appear here. */
    custody: {
      refPresent: Boolean(row.custody_ref),
      // never include secret
    },
  };
}

export type InfraStellarAccountView = ReturnType<typeof mapPublic>;

async function loadAccount(
  orgId: string,
  env: InfraEnv,
  network: StellarNetwork,
  asset = 'USDC'
): Promise<AccountRow | null> {
  return db.oneOrNone<AccountRow>(
    `${SELECT}
     WHERE org_id = $1 AND environment = $2 AND network = $3 AND asset = $4`,
    [orgId, env, network, asset]
  );
}

export async function getOrgStellarAccount(
  orgId: string,
  environment: InfraEnv | string
): Promise<InfraStellarAccountView | null> {
  const env = asEnv(String(environment));
  const cfg = getStellarConfig();
  const network: StellarNetwork = cfg.isTestnet ? 'testnet' : 'mainnet';
  const row = await loadAccount(orgId, env, network, 'USDC');
  return row ? mapPublic(row) : null;
}

/** Reverse lookup for inbound deposits (Increment D). */
export async function findOrgStellarAccountByPublicKey(
  publicKey: string
): Promise<InfraStellarAccountView | null> {
  const pk = String(publicKey || '').trim();
  if (!/^G[A-Z0-9]{55}$/.test(pk)) return null;
  const row = await db.oneOrNone<AccountRow>(
    `${SELECT} WHERE public_key = $1 LIMIT 1`,
    [pk]
  );
  return row ? mapPublic(row) : null;
}

/** Active org wallets eligible for deposit polling. */
export async function listActiveOrgStellarAccounts(input?: {
  environment?: InfraEnv | string;
  network?: StellarNetwork;
}): Promise<InfraStellarAccountView[]> {
  const cfg = getStellarConfig();
  const network: StellarNetwork =
    input?.network || (cfg.isTestnet ? 'testnet' : 'mainnet');
  const env = input?.environment ? asEnv(String(input.environment)) : null;
  const rows = env
    ? await db.manyOrNone<AccountRow>(
        `${SELECT}
         WHERE status = 'active' AND network = $1 AND environment = $2 AND asset = 'USDC'`,
        [network, env]
      )
    : await db.manyOrNone<AccountRow>(
        `${SELECT}
         WHERE status = 'active' AND network = $1 AND asset = 'USDC'`,
        [network]
      );
  return rows.map(mapPublic);
}

async function patchStatus(
  id: string,
  status: StellarAccountStatus,
  fields: {
    failureReason?: string | null;
    xlmFundedAt?: Date | null;
    trustlineAt?: Date | null;
    activatedAt?: Date | null;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<AccountRow> {
  return db.one<AccountRow>(
    `UPDATE infra_stellar_accounts SET
       status = $2,
       failure_reason = COALESCE($3, failure_reason),
       xlm_funded_at = COALESCE($4, xlm_funded_at),
       trustline_at = COALESCE($5, trustline_at),
       activated_at = COALESCE($6, activated_at),
       metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($7::jsonb, '{}'::jsonb),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id::text AS id, org_id::text AS org_id, environment,
               public_key, network, asset, usdc_issuer, status,
               custody_ref::text AS custody_ref, failure_reason,
               xlm_funded_at, trustline_at, activated_at, metadata,
               created_at, updated_at`,
    [
      id,
      status,
      fields.failureReason ?? null,
      fields.xlmFundedAt ?? null,
      fields.trustlineAt ?? null,
      fields.activatedAt ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ]
  );
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const cfg = getStellarConfig();
  if (!cfg.isTestnet || !cfg.friendbotUrl) {
    throw new InfraStellarAccountError(
      'Friendbot is only available on Stellar Testnet',
      'FRIENDBOT_UNAVAILABLE',
      400
    );
  }
  const res = await fetch(
    `${cfg.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`
  );
  const bodyText = await res.text();
  if (!res.ok) {
    const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
    try {
      await server.loadAccount(publicKey);
      return;
    } catch {
      throw new InfraStellarAccountError(
        `Friendbot failed (${res.status}): ${bodyText.slice(0, 400)}`,
        'XLM_FUND_FAILED',
        502
      );
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}

async function ensureUsdcTrustline(
  publicKey: string,
  secret: string,
  issuer: string
): Promise<void> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const asset = new StellarSdk.Asset('USDC', issuer);
  const account = await server.loadAccount(publicKey);
  const already = (
    account.balances as { asset_code?: string; asset_issuer?: string }[]
  ).some(
    (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer()
  );
  if (already) return;

  const kp = StellarSdk.Keypair.fromSecret(secret);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: '1000000000',
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);
  try {
    await server.submitTransaction(tx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InfraStellarAccountError(
      `USDC trustline failed: ${msg}`.slice(0, 500),
      'TRUSTLINE_FAILED',
      502
    );
  }
  await new Promise((r) => setTimeout(r, 800));
}

async function runLiveProvision(row: AccountRow): Promise<AccountRow> {
  const cfg = getStellarConfig();
  if (!cfg.isTestnet) {
    throw new InfraStellarAccountError(
      'Increment B live provisioning is Testnet-only. Set STELLAR_NETWORK=testnet.',
      'MAINNET_PROVISION_BLOCKED',
      400
    );
  }

  const custody = getStellarCustodyProvider();
  const secret = await custody.getSigningSecret(row.custody_ref);
  const issuer = resolveUsdcIssuer(true);

  await fundWithFriendbot(row.public_key);
  let next = await patchStatus(row.id, 'xlm_ready', {
    xlmFundedAt: new Date(),
    failureReason: null,
    metadata: { provisionMode: 'live', xlmSource: 'friendbot' },
  });

  await ensureUsdcTrustline(row.public_key, secret, issuer);
  next = await patchStatus(next.id, 'trustline_ready', {
    trustlineAt: new Date(),
    metadata: { usdcIssuer: issuer },
  });

  next = await patchStatus(next.id, 'active', {
    activatedAt: new Date(),
  });
  return next;
}

async function runMockProvision(row: AccountRow): Promise<AccountRow> {
  const issuer = resolveUsdcIssuer(getStellarConfig().isTestnet);
  let next = await patchStatus(row.id, 'xlm_ready', {
    xlmFundedAt: new Date(),
    failureReason: null,
    metadata: { provisionMode: 'mock', xlmSource: 'mock' },
  });
  next = await patchStatus(next.id, 'trustline_ready', {
    trustlineAt: new Date(),
    metadata: { usdcIssuer: issuer, trustline: 'mock' },
  });
  next = await patchStatus(next.id, 'active', {
    activatedAt: new Date(),
  });
  return next;
}

/**
 * Idempotent org Stellar wallet provisioning.
 * Safe public metadata only; secrets stay in custody vault.
 */
export async function provisionOrgStellarAccount(input: {
  orgId: string;
  environment: InfraEnv | string;
  /** Force mock/live; defaults to DAYFI_INFRA_STELLAR_PROVISION_MODE */
  mode?: 'mock' | 'live';
}): Promise<InfraStellarAccountView> {
  const env = asEnv(String(input.environment));
  const cfg = getStellarConfig();
  const network: StellarNetwork = cfg.isTestnet ? 'testnet' : 'mainnet';
  const mode = input.mode || getInfraStellarProvisionMode();
  const lockKey = `${input.orgId}:${env}:${network}:USDC`;

  const existingRun = provisionLocks.get(lockKey);
  if (existingRun) {
    await existingRun;
    const again = await loadAccount(input.orgId, env, network, 'USDC');
    if (again?.status === 'active') return mapPublic(again);
  }

  const work = (async () => {
    let row = await loadAccount(input.orgId, env, network, 'USDC');

    if (row?.status === 'active') {
      return mapPublic(row);
    }

    if (!row) {
      const custody = getStellarCustodyProvider();
      const { custodyRef, publicKey } = await custody.createKeypairAndStore();
      const issuer = resolveUsdcIssuer(cfg.isTestnet);
      try {
        row = await db.one<AccountRow>(
          `INSERT INTO infra_stellar_accounts
             (org_id, environment, public_key, network, asset, usdc_issuer,
              status, custody_ref, metadata)
           VALUES ($1, $2, $3, $4, 'USDC', $5, 'provisioning', $6, $7::jsonb)
           RETURNING id::text AS id, org_id::text AS org_id, environment,
                     public_key, network, asset, usdc_issuer, status,
                     custody_ref::text AS custody_ref, failure_reason,
                     xlm_funded_at, trustline_at, activated_at, metadata,
                     created_at, updated_at`,
          [
            input.orgId,
            env,
            publicKey,
            network,
            issuer,
            custodyRef,
            JSON.stringify({ provisionMode: mode }),
          ]
        );
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: string }).code)
            : '';
        if (code === '23505') {
          row = await loadAccount(input.orgId, env, network, 'USDC');
          if (!row) throw err;
        } else {
          throw err;
        }
      }
    }

    if (!row) {
      throw new InfraStellarAccountError(
        'Failed to create Stellar account row',
        'CREATE_FAILED',
        500
      );
    }

    if (row.status === 'active') return mapPublic(row);

    try {
      const finished =
        mode === 'live' ? await runLiveProvision(row) : await runMockProvision(row);
      return mapPublic(finished);
    } catch (err: unknown) {
      const message =
        err instanceof InfraStellarAccountError || err instanceof StellarCustodyError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      await patchStatus(row.id, 'failed', {
        failureReason: message.slice(0, 1000),
      });
      if (err instanceof InfraStellarAccountError || err instanceof StellarCustodyError) {
        throw err;
      }
      throw new InfraStellarAccountError(message, 'PROVISION_FAILED', 502);
    }
  })();

  provisionLocks.set(lockKey, work);
  try {
    return (await work) as InfraStellarAccountView;
  } finally {
    provisionLocks.delete(lockKey);
  }
}

/** Internal: resolve signing secret for org wallet (settlement / funding). Never HTTP. */
export async function getOrgStellarSigningSecret(
  orgId: string,
  environment: InfraEnv | string
): Promise<{ publicKey: string; secret: string; accountId: string }> {
  const account = await getOrgStellarAccount(orgId, environment);
  if (!account || account.status !== 'active') {
    throw new InfraStellarAccountError(
      'Organization Stellar wallet is not active',
      'WALLET_NOT_ACTIVE',
      409
    );
  }
  const row = await loadAccount(
    orgId,
    asEnv(String(environment)),
    account.network,
    'USDC'
  );
  if (!row) {
    throw new InfraStellarAccountError('Stellar account missing', 'NOT_FOUND', 404);
  }
  const secret = await getStellarCustodyProvider().getSigningSecret(row.custody_ref);
  return { publicKey: row.public_key, secret, accountId: row.id };
}
