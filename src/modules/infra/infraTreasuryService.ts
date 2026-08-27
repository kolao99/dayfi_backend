/**
 * Increment G — Treasury / Liquidity Management (observation + manual rebalance).
 *
 * Core invariants:
 *   - Ledger liabilities ≠ on-chain treasury liquidity
 *   - Customer custody wallets ≠ treasury liquidity
 *   - No automatic sweep / trade / rebalance bot
 *   - Manual rebalance moves Dayfi-owned funds only
 *
 * Extends existing ledger, Horizon observation, settlements, and H/C flows.
 */

import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';
import { FEE_ORG_SLUG } from './infraFeeService';
import {
  getDayfiTreasuryPublicKey,
  observeDayfiTreasuryOnChain,
} from './infraStellarFundingService';
import {
  getStellarSettlementMode,
  submitUsdcPayment,
  verifyUsdcPayment,
  StellarSettlementAdapterError,
} from './stellarSettlementAdapter';
import type { InfraEnvironment } from './infraLedgerService';

export type TreasuryStatus =
  | 'HEALTHY'
  | 'LOW_LIQUIDITY'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'RECONCILIATION_REQUIRED'
  | 'FROZEN'
  | 'UNCONFIGURED';

export type RebalanceStatus =
  | 'requested'
  | 'approved'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export class InfraTreasuryError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraTreasuryError';
    this.code = code;
    this.status = status;
  }
}

type RebalanceRow = {
  id: string;
  environment: string;
  asset: string;
  source_kind: string;
  destination_kind: string;
  source_ref: string;
  destination_ref: string;
  amount: string;
  status: string;
  purpose: string;
  external_reference: string | null;
  rail: string;
  rail_metadata: Record<string, unknown>;
  failure_reason: string | null;
  idempotency_key: string;
  requested_by: string | null;
  liabilities_snapshot: string | null;
  liquidity_snapshot: string | null;
  shortfall_snapshot: string | null;
  submitted_at: Date | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const REBALANCE_SELECT = `SELECT id::text AS id, environment, asset, source_kind, destination_kind,
  source_ref, destination_ref, amount::text, status, purpose, external_reference, rail,
  rail_metadata, failure_reason, idempotency_key, requested_by,
  liabilities_snapshot::text, liquidity_snapshot::text, shortfall_snapshot::text,
  submitted_at, confirmed_at, created_at, updated_at
 FROM infra_treasury_rebalances`;

function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

function formatMoney(n: number): string {
  return round7(n).toFixed(7).replace(/\.?0+$/, '') || '0';
}

function isTreasuryFrozen(): boolean {
  const raw = String(process.env.DAYFI_TREASURY_FROZEN || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

function treasurySecret(): string | null {
  const secret =
    process.env.DAYFI_STELLAR_SETTLEMENT_SECRET?.trim() ||
    process.env.MASTER_WALLET_SECRET_KEY?.trim() ||
    '';
  return secret || null;
}

function healthyCoverageThreshold(): number {
  const n = Number(process.env.DAYFI_TREASURY_HEALTHY_COVERAGE || '1.05');
  return Number.isFinite(n) && n > 0 ? n : 1.05;
}

function lowCoverageThreshold(): number {
  const n = Number(process.env.DAYFI_TREASURY_LOW_COVERAGE || '1.0');
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

function assertGAddress(value: string, label: string): string {
  const v = String(value || '').trim();
  if (!/^G[A-Z2-7]{55}$/.test(v)) {
    throw new InfraTreasuryError(
      `Invalid ${label} Stellar address`,
      'INVALID_STELLAR_ADDRESS'
    );
  }
  return v;
}

function mapRebalance(row: RebalanceRow) {
  return {
    id: row.id,
    environment: row.environment,
    asset: row.asset,
    sourceKind: row.source_kind,
    destinationKind: row.destination_kind,
    sourceRef: row.source_ref,
    destinationRef: row.destination_ref,
    amount: Number(row.amount),
    status: row.status as RebalanceStatus,
    purpose: row.purpose,
    externalReference: row.external_reference,
    stellarTransactionHash: row.external_reference,
    rail: row.rail,
    railMetadata: row.rail_metadata || {},
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    requestedBy: row.requested_by,
    liabilitiesSnapshot:
      row.liabilities_snapshot != null ? Number(row.liabilities_snapshot) : null,
    liquiditySnapshot:
      row.liquidity_snapshot != null ? Number(row.liquidity_snapshot) : null,
    shortfallSnapshot:
      row.shortfall_snapshot != null ? Number(row.shortfall_snapshot) : null,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Aggregate customer ledger liabilities from existing infra_wallet_accounts.
 * Excludes Dayfi fee-revenue org (platform revenue, not customer liability).
 */
export async function getCustomerLiabilityTotals(input: {
  environment: InfraEnvironment | string;
  asset?: string;
}): Promise<{
  environment: string;
  asset: string;
  totalCustomerLiability: number;
  totalAvailableCustomerFunds: number;
  totalPendingCustomerFunds: number;
  totalLockedCustomerFunds: number;
  orgCount: number;
  excludedFeeRevenue: number;
}> {
  const environment = String(input.environment || 'test');
  const asset = String(input.asset || 'USDC');

  const row = await db.one<{
    available: string;
    pending: string;
    locked: string;
    org_count: string;
  }>(
    `SELECT
       COALESCE(SUM(w.available), 0)::text AS available,
       COALESCE(SUM(w.pending), 0)::text AS pending,
       COALESCE(SUM(w.locked), 0)::text AS locked,
       COUNT(*)::text AS org_count
     FROM infra_wallet_accounts w
     JOIN infra_organizations o ON o.id = w.org_id
     WHERE w.environment = $1
       AND w.asset = $2
       AND w.status = 'active'
       AND o.slug IS DISTINCT FROM $3`,
    [environment, asset, FEE_ORG_SLUG]
  );

  const feeRow = await db.one<{ total: string }>(
    `SELECT COALESCE(SUM(w.available + w.pending + w.locked), 0)::text AS total
     FROM infra_wallet_accounts w
     JOIN infra_organizations o ON o.id = w.org_id
     WHERE w.environment = $1
       AND w.asset = $2
       AND o.slug = $3`,
    [environment, asset, FEE_ORG_SLUG]
  );

  const available = Number(row.available) || 0;
  const pending = Number(row.pending) || 0;
  const locked = Number(row.locked) || 0;

  return {
    environment,
    asset,
    totalAvailableCustomerFunds: round7(available),
    totalPendingCustomerFunds: round7(pending),
    totalLockedCustomerFunds: round7(locked),
    totalCustomerLiability: round7(available + pending + locked),
    orgCount: Number(row.org_count) || 0,
    excludedFeeRevenue: round7(Number(feeRow.total) || 0),
  };
}

async function getPendingObligations(environment: string): Promise<{
  pendingCustomerFunding: number;
  pendingProviderPayouts: number;
  pendingProviderRetryRequired: number;
  confirmedSettlementsUsdc: number;
  failedSettlementsUsdc: number;
}> {
  const pendingFunding = await db.one<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
     FROM infra_settlements
     WHERE environment = $1
       AND status = 'pending_treasury'
       AND asset = 'USDC'`,
    [environment]
  );

  const providerPending = await db.one<{ total: string }>(
    `SELECT COALESCE(SUM(s.amount), 0)::text AS total
     FROM infra_settlements s
     JOIN infra_transactions t ON t.id = s.payout_transaction_id
     WHERE s.environment = $1
       AND UPPER(s.rail) IN ('YELLOW_CARD', 'PROVIDER')
       AND LOWER(s.status) IN ('pending', 'submitted')
       AND COALESCE(t.metadata->>'offRamp', 'false') = 'true'
       AND COALESCE(t.metadata->>'stellarConfirmed', 'false') = 'true'`,
    [environment]
  );

  const providerRetry = await db.one<{ total: string }>(
    `SELECT COALESCE(SUM(s.amount), 0)::text AS total
     FROM infra_settlements s
     JOIN infra_transactions t ON t.id = s.payout_transaction_id
     WHERE s.environment = $1
       AND UPPER(s.rail) IN ('YELLOW_CARD', 'PROVIDER')
       AND LOWER(s.status) = 'failed'
       AND COALESCE(t.metadata->>'offRamp', 'false') = 'true'
       AND COALESCE(t.metadata->>'stellarConfirmed', 'false') = 'true'`,
    [environment]
  );

  const confirmed = await db.one<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
     FROM infra_settlements
     WHERE environment = $1
       AND LOWER(status) = 'confirmed'
       AND asset = 'USDC'
       AND UPPER(rail) = 'STELLAR'`,
    [environment]
  );

  const failed = await db.one<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
     FROM infra_settlements
     WHERE environment = $1
       AND LOWER(status) = 'failed'
       AND asset = 'USDC'`,
    [environment]
  );

  return {
    pendingCustomerFunding: round7(Number(pendingFunding.total) || 0),
    pendingProviderPayouts: round7(Number(providerPending.total) || 0),
    pendingProviderRetryRequired: round7(Number(providerRetry.total) || 0),
    confirmedSettlementsUsdc: round7(Number(confirmed.total) || 0),
    failedSettlementsUsdc: round7(Number(failed.total) || 0),
  };
}

/**
 * Customer org Stellar wallet USDC totals — NOT treasury liquidity.
 * Observation only; Horizon-backed when accounts exist.
 */
export async function observeCustomerCustodyUsdc(input: {
  environment: InfraEnvironment | string;
}): Promise<{
  totalOnChainUsdc: number;
  accountCount: number;
  note: string;
}> {
  const environment = String(input.environment || 'test');
  const treasuryPk = getDayfiTreasuryPublicKey();
  const accounts = await db.manyOrNone<{ public_key: string }>(
    `SELECT public_key
     FROM infra_stellar_accounts
     WHERE environment = $1
       AND status = 'active'
       AND public_key IS NOT NULL`,
    [environment]
  );

  const cfg = getStellarConfig();
  const issuer = resolveUsdcIssuer(cfg.isTestnet);
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  let total = 0;
  let counted = 0;

  // Mock mode: do not hit Horizon; treat as unobserved for liquidity (still not treasury).
  if (getStellarSettlementMode() === 'mock') {
    return {
      totalOnChainUsdc: 0,
      accountCount: accounts.length,
      note: 'Customer custody balances are not treasury liquidity (mock observation skipped Horizon)',
    };
  }

  for (const a of accounts) {
    const pk = String(a.public_key || '').trim();
    if (!pk || pk === treasuryPk) continue;
    try {
      const account = await server.loadAccount(pk);
      const usdc = (
        account.balances as {
          asset_code?: string;
          asset_issuer?: string;
          balance?: string;
        }[]
      ).find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
      const n = parseFloat(String(usdc?.balance || '0'));
      if (Number.isFinite(n)) {
        total += n;
        counted += 1;
      }
    } catch {
      // Account may not exist on-chain yet — skip; mismatch surfaces in recon.
    }
  }

  return {
    totalOnChainUsdc: round7(total),
    accountCount: counted,
    note: 'Customer custody balances are NOT Dayfi treasury liquidity',
  };
}

function classifyTreasuryStatus(input: {
  frozen: boolean;
  configured: boolean;
  observationOk: boolean;
  coverageRatio: number | null;
  unexplainedDifferences: string[];
}): TreasuryStatus {
  if (!input.configured) return 'UNCONFIGURED';
  if (input.frozen) return 'FROZEN';
  if (!input.observationOk || input.unexplainedDifferences.length > 0) {
    return 'RECONCILIATION_REQUIRED';
  }
  const coverage = input.coverageRatio;
  if (coverage == null) return 'RECONCILIATION_REQUIRED';
  if (coverage < lowCoverageThreshold()) return 'INSUFFICIENT_LIQUIDITY';
  if (coverage < healthyCoverageThreshold()) return 'LOW_LIQUIDITY';
  return 'HEALTHY';
}

export async function getTreasuryPosition(input?: {
  environment?: InfraEnvironment | string;
}): Promise<{
  network: string;
  environment: string;
  publicKey: string | null;
  status: TreasuryStatus;
  usdc: {
    onChainBalance: string;
    customerLiability: string;
    customerAvailable: string;
    customerPending: string;
    customerLocked: string;
    liquidityGap: string;
    coverageRatio: string | null;
    availableLiquidity: string;
  };
  xlm: { onChainBalance: string };
  obligations: {
    pendingCustomerFunding: string;
    pendingProviderPayouts: string;
    pendingProviderRetryRequired: string;
  };
  customerCustody: {
    onChainUsdc: string;
    accountCount: number;
    countedAsTreasury: false;
    note: string;
  };
  dayfiFeeRevenue: { ledgerUsdc: string; note: string };
  lastObservedAt: string | null;
  lastReconciledAt: string;
  differences: string[];
}> {
  const environment = String(input?.environment || 'test') as InfraEnvironment;
  const frozen = isTreasuryFrozen();
  const onChain = await observeDayfiTreasuryOnChain();
  const liabilities = await getCustomerLiabilityTotals({ environment });
  const obligations = await getPendingObligations(environment);
  const customerCustody = await observeCustomerCustodyUsdc({ environment });

  const differences: string[] = [];
  if (!onChain) {
    differences.push('Unable to observe Dayfi treasury on Horizon');
  }

  const onChainUsdc = onChain?.usdc ?? 0;
  const availableLiquidity = round7(onChainUsdc);
  const liability = liabilities.totalCustomerLiability;
  const gap = round7(liability - availableLiquidity);
  const coverage =
    liability > 0 ? round7(availableLiquidity / liability) : availableLiquidity > 0 ? null : 1;

  // Explicit: customer custody must never be added into availableLiquidity.
  if (customerCustody.totalOnChainUsdc > 0) {
    // Informational only — not a mismatch.
  }

  const status = classifyTreasuryStatus({
    frozen,
    configured: Boolean(onChain?.publicKey || getDayfiTreasuryPublicKey()),
    observationOk: Boolean(onChain),
    coverageRatio:
      liability === 0
        ? availableLiquidity >= 0
          ? Math.max(healthyCoverageThreshold(), 1)
          : 0
        : coverage,
    unexplainedDifferences: differences,
  });

  const reconciledAt = new Date().toISOString();

  return {
    network: onChain?.network || (getStellarConfig().isTestnet ? 'testnet' : 'public'),
    environment,
    publicKey: onChain?.publicKey || getDayfiTreasuryPublicKey(),
    status,
    usdc: {
      onChainBalance: formatMoney(onChainUsdc),
      customerLiability: formatMoney(liability),
      customerAvailable: formatMoney(liabilities.totalAvailableCustomerFunds),
      customerPending: formatMoney(liabilities.totalPendingCustomerFunds),
      customerLocked: formatMoney(liabilities.totalLockedCustomerFunds),
      liquidityGap: formatMoney(gap * -1), // negative means shortfall (liability > liquidity)
      coverageRatio:
        liability === 0
          ? availableLiquidity >= 0
            ? 'n/a'
            : '0'
          : (coverage ?? 0).toFixed(4),
      availableLiquidity: formatMoney(availableLiquidity),
    },
    xlm: {
      onChainBalance: formatMoney(onChain?.xlm ?? 0),
    },
    obligations: {
      pendingCustomerFunding: formatMoney(obligations.pendingCustomerFunding),
      pendingProviderPayouts: formatMoney(obligations.pendingProviderPayouts),
      pendingProviderRetryRequired: formatMoney(
        obligations.pendingProviderRetryRequired
      ),
    },
    customerCustody: {
      onChainUsdc: formatMoney(customerCustody.totalOnChainUsdc),
      accountCount: customerCustody.accountCount,
      countedAsTreasury: false,
      note: customerCustody.note,
    },
    dayfiFeeRevenue: {
      ledgerUsdc: formatMoney(liabilities.excludedFeeRevenue),
      note: 'Dayfi USDC fee revenue is platform equity, not customer liability',
    },
    lastObservedAt: onChain?.observedAt || null,
    lastReconciledAt: reconciledAt,
    differences,
  };
}

/**
 * Observe-only treasury reconciliation report (never mutates money).
 */
export async function reconcileTreasuryPosition(input?: {
  environment?: InfraEnvironment | string;
}): Promise<{
  status: TreasuryStatus;
  position: Awaited<ReturnType<typeof getTreasuryPosition>>;
  legs: Array<{
    name: string;
    amount: string;
    role: string;
  }>;
  resultCode: string;
  notes: string[];
}> {
  const position = await getTreasuryPosition(input);
  const notes: string[] = [...position.differences];

  notes.push(
    'Customer liability comes from infra ledger (available+pending+locked)'
  );
  notes.push('Treasury USDC comes from live Horizon observation');
  notes.push('Customer Stellar wallets are excluded from treasury liquidity');
  notes.push('E/E-ONCHAIN and F do not move Dayfi treasury USDC');
  notes.push('C drains treasury → customer; H credits treasury from customer');

  const liability = Number(position.usdc.customerLiability);
  const liquidity = Number(position.usdc.availableLiquidity);
  const gap = liability - liquidity;

  let resultCode = 'TREASURY_RECONCILED';
  if (position.status === 'RECONCILIATION_REQUIRED') {
    resultCode = 'TREASURY_OBSERVATION_INCOMPLETE';
  } else if (gap > 1e-7) {
    resultCode = 'LIQUIDITY_SHORTFALL';
  } else if (position.status === 'LOW_LIQUIDITY') {
    resultCode = 'LIQUIDITY_THIN';
  }

  return {
    status: position.status,
    position,
    legs: [
      {
        name: 'customer_liability',
        amount: position.usdc.customerLiability,
        role: 'obligation',
      },
      {
        name: 'treasury_usdc',
        amount: position.usdc.onChainBalance,
        role: 'liquidity',
      },
      {
        name: 'pending_customer_funding',
        amount: position.obligations.pendingCustomerFunding,
        role: 'treasury_out_queue',
      },
      {
        name: 'pending_provider_payouts',
        amount: position.obligations.pendingProviderPayouts,
        role: 'provider_obligation',
      },
      {
        name: 'provider_retry_required',
        amount: position.obligations.pendingProviderRetryRequired,
        role: 'provider_obligation',
      },
      {
        name: 'customer_custody_usdc',
        amount: position.customerCustody.onChainUsdc,
        role: 'not_treasury',
      },
    ],
    resultCode,
    notes,
  };
}

function allowlistedSecondaryTreasuryKeys(): Set<string> {
  const keys = new Set<string>();
  const a = process.env.DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY?.trim();
  if (a) keys.add(a);
  const b = process.env.DAYFI_STELLAR_SECONDARY_TREASURY_PUBLIC_KEY?.trim();
  if (b) keys.add(b);
  const list = String(process.env.DAYFI_STELLAR_TREASURY_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of list) keys.add(k);
  return keys;
}

async function assertDestinationIsDayfiOwned(destination: string): Promise<void> {
  const dest = assertGAddress(destination, 'destination');
  const treasury = getDayfiTreasuryPublicKey();
  if (treasury && dest === treasury) {
    throw new InfraTreasuryError(
      'Destination cannot equal the source treasury',
      'SELF_TRANSFER'
    );
  }

  const customer = await db.oneOrNone<{ id: string }>(
    `SELECT id::text AS id FROM infra_stellar_accounts
     WHERE public_key = $1 AND status = 'active'
     LIMIT 1`,
    [dest]
  );
  if (customer) {
    throw new InfraTreasuryError(
      'Cannot rebalance to a customer custody wallet',
      'CUSTOMER_WALLET_FORBIDDEN',
      403
    );
  }

  const allow = allowlistedSecondaryTreasuryKeys();
  if (allow.size > 0 && !allow.has(dest)) {
    throw new InfraTreasuryError(
      'Destination is not an allowlisted Dayfi treasury account',
      'DESTINATION_NOT_ALLOWLISTED',
      403
    );
  }
  if (allow.size === 0) {
    // Without allowlist, still require explicit env opt-in for safety in live.
    const open = String(process.env.DAYFI_TREASURY_REBALANCE_OPEN || '')
      .trim()
      .toLowerCase();
    if (open !== '1' && open !== 'true' && getStellarSettlementMode() === 'live') {
      throw new InfraTreasuryError(
        'Configure DAYFI_STELLAR_TREASURY_B_PUBLIC_KEY (or allowlist) before live rebalance',
        'REBALANCE_NOT_CONFIGURED',
        403
      );
    }
  }
}

function assertEnvironmentNetwork(environment: string): void {
  const cfg = getStellarConfig();
  if (environment === 'test' && !cfg.isTestnet) {
    throw new InfraTreasuryError(
      'test environment requires Stellar testnet',
      'WRONG_NETWORK',
      403
    );
  }
  if (environment === 'live' && cfg.isTestnet) {
    throw new InfraTreasuryError(
      'live environment cannot use Stellar testnet',
      'WRONG_NETWORK',
      403
    );
  }
}

/**
 * Create a manual rebalance request (idempotent). Does not move funds.
 */
export async function requestTreasuryRebalance(input: {
  environment?: InfraEnvironment | string;
  amount: number;
  destinationPublicKey: string;
  idempotencyKey: string;
  requestedBy?: string;
  purpose?: string;
  autoApprove?: boolean;
}): Promise<ReturnType<typeof mapRebalance> & { duplicate?: boolean }> {
  if (isTreasuryFrozen()) {
    throw new InfraTreasuryError('Treasury is frozen', 'TREASURY_FROZEN', 403);
  }

  const environment = String(input.environment || 'test');
  assertEnvironmentNetwork(environment);

  const amount = round7(Number(input.amount));
  if (!(amount > 0)) {
    throw new InfraTreasuryError('Amount must be positive', 'INVALID_AMOUNT');
  }

  const source = getDayfiTreasuryPublicKey();
  if (!source) {
    throw new InfraTreasuryError(
      'Dayfi treasury public key is not configured',
      'TREASURY_UNCONFIGURED',
      503
    );
  }

  const destination = assertGAddress(
    input.destinationPublicKey,
    'destination'
  );
  await assertDestinationIsDayfiOwned(destination);

  const existing = await db.oneOrNone<RebalanceRow>(
    `${REBALANCE_SELECT} WHERE environment = $1 AND idempotency_key = $2`,
    [environment, input.idempotencyKey]
  );
  if (existing) {
    return { ...mapRebalance(existing), duplicate: true };
  }

  const position = await getTreasuryPosition({ environment });
  const onChain = Number(position.usdc.onChainBalance);
  if (onChain + 1e-9 < amount) {
    throw new InfraTreasuryError(
      `Insufficient treasury USDC (have ${onChain}, need ${amount})`,
      'INSUFFICIENT_TREASURY_USDC'
    );
  }

  const status: RebalanceStatus = input.autoApprove ? 'approved' : 'requested';

  try {
    const row = await db.one<RebalanceRow>(
      `INSERT INTO infra_treasury_rebalances (
         environment, asset, source_kind, destination_kind, source_ref, destination_ref,
         amount, status, purpose, idempotency_key, requested_by,
         liabilities_snapshot, liquidity_snapshot, shortfall_snapshot
       ) VALUES (
         $1, 'USDC', 'dayfi_treasury', 'dayfi_treasury', $2, $3,
         $4, $5, $6, $7, $8, $9, $10, $11
       )
       RETURNING id::text AS id, environment, asset, source_kind, destination_kind,
         source_ref, destination_ref, amount::text, status, purpose, external_reference, rail,
         rail_metadata, failure_reason, idempotency_key, requested_by,
         liabilities_snapshot::text, liquidity_snapshot::text, shortfall_snapshot::text,
         submitted_at, confirmed_at, created_at, updated_at`,
      [
        environment,
        source,
        destination,
        amount,
        status,
        input.purpose || 'manual',
        input.idempotencyKey,
        input.requestedBy || null,
        Number(position.usdc.customerLiability),
        onChain,
        Number(position.usdc.customerLiability) - onChain,
      ]
    );
    return mapRebalance(row);
  } catch (err: any) {
    if (err?.code === '23505') {
      const again = await db.one<RebalanceRow>(
        `${REBALANCE_SELECT} WHERE environment = $1 AND idempotency_key = $2`,
        [environment, input.idempotencyKey]
      );
      return { ...mapRebalance(again), duplicate: true };
    }
    throw err;
  }
}

export async function approveTreasuryRebalance(input: {
  rebalanceId: string;
  environment?: string;
}): Promise<ReturnType<typeof mapRebalance>> {
  if (isTreasuryFrozen()) {
    throw new InfraTreasuryError('Treasury is frozen', 'TREASURY_FROZEN', 403);
  }
  const row = await db.oneOrNone<RebalanceRow>(
    `${REBALANCE_SELECT} WHERE id = $1`,
    [input.rebalanceId]
  );
  if (!row) {
    throw new InfraTreasuryError('Rebalance not found', 'NOT_FOUND', 404);
  }
  if (input.environment && row.environment !== input.environment) {
    throw new InfraTreasuryError(
      'Cross-environment rebalance is forbidden',
      'CROSS_ENVIRONMENT',
      403
    );
  }
  if (row.status === 'approved' || row.status === 'submitted' || row.status === 'confirmed') {
    return mapRebalance(row);
  }
  if (row.status !== 'requested') {
    throw new InfraTreasuryError(
      `Cannot approve rebalance in status ${row.status}`,
      'INVALID_STATUS'
    );
  }
  const updated = await db.one<RebalanceRow>(
    `UPDATE infra_treasury_rebalances
     SET status = 'approved', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id::text AS id, environment, asset, source_kind, destination_kind,
       source_ref, destination_ref, amount::text, status, purpose, external_reference, rail,
       rail_metadata, failure_reason, idempotency_key, requested_by,
       liabilities_snapshot::text, liquidity_snapshot::text, shortfall_snapshot::text,
       submitted_at, confirmed_at, created_at, updated_at`,
    [input.rebalanceId]
  );
  return mapRebalance(updated);
}

/**
 * Submit + confirm a manual treasury→treasury USDC rebalance.
 * Idempotent: confirmed rows return existing hash; never double-submits.
 */
export async function submitTreasuryRebalance(input: {
  rebalanceId: string;
  environment?: string;
}): Promise<
  ReturnType<typeof mapRebalance> & {
    duplicate?: boolean;
    actualNetworkFeeXlm?: string | null;
  }
> {
  if (isTreasuryFrozen()) {
    throw new InfraTreasuryError('Treasury is frozen', 'TREASURY_FROZEN', 403);
  }

  const row = await db.oneOrNone<RebalanceRow>(
    `${REBALANCE_SELECT} WHERE id = $1`,
    [input.rebalanceId]
  );
  if (!row) {
    throw new InfraTreasuryError('Rebalance not found', 'NOT_FOUND', 404);
  }
  if (input.environment && row.environment !== input.environment) {
    throw new InfraTreasuryError(
      'Cross-environment rebalance is forbidden',
      'CROSS_ENVIRONMENT',
      403
    );
  }
  assertEnvironmentNetwork(row.environment);

  if (row.status === 'confirmed' && row.external_reference) {
    return {
      ...mapRebalance(row),
      duplicate: true,
      actualNetworkFeeXlm:
        (row.rail_metadata?.actualNetworkFeeXlm as string) || null,
    };
  }
  if (row.status === 'submitted' && row.external_reference) {
    const verified = await verifyUsdcPayment(row.external_reference);
    if (verified.confirmed) {
      const confirmed = await db.one<RebalanceRow>(
        `UPDATE infra_treasury_rebalances SET
           status = 'confirmed',
           confirmed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $2::jsonb
         WHERE id = $1
         RETURNING id::text AS id, environment, asset, source_kind, destination_kind,
           source_ref, destination_ref, amount::text, status, purpose, external_reference, rail,
           rail_metadata, failure_reason, idempotency_key, requested_by,
           liabilities_snapshot::text, liquidity_snapshot::text, shortfall_snapshot::text,
           submitted_at, confirmed_at, created_at, updated_at`,
        [
          row.id,
          JSON.stringify({
            horizonConfirmed: true,
            confirmedLedgerSequence: verified.ledgerSequence ?? null,
          }),
        ]
      );
      return mapRebalance(confirmed);
    }
  }
  if (row.status !== 'approved' && row.status !== 'requested' && row.status !== 'failed') {
    throw new InfraTreasuryError(
      `Cannot submit rebalance in status ${row.status}`,
      'INVALID_STATUS'
    );
  }

  await assertDestinationIsDayfiOwned(row.destination_ref);

  const secret = treasurySecret();
  if (!secret && getStellarSettlementMode() === 'live') {
    throw new InfraTreasuryError(
      'Treasury signing secret is not configured',
      'TREASURY_SECRET_MISSING',
      503
    );
  }

  // Ensure source matches configured treasury (never a customer wallet).
  const treasuryPk = getDayfiTreasuryPublicKey();
  if (!treasuryPk || row.source_ref !== treasuryPk) {
    throw new InfraTreasuryError(
      'Rebalance source must be the configured Dayfi treasury',
      'INVALID_SOURCE',
      403
    );
  }
  if (secret) {
    try {
      const kp = StellarSdk.Keypair.fromSecret(secret);
      if (kp.publicKey() !== treasuryPk) {
        throw new InfraTreasuryError(
          'Treasury secret does not match treasury public key',
          'TREASURY_KEY_MISMATCH',
          500
        );
      }
    } catch (err: any) {
      if (err instanceof InfraTreasuryError) throw err;
      throw new InfraTreasuryError(
        'Invalid treasury signing secret',
        'TREASURY_SECRET_INVALID',
        500
      );
    }
  }

  const onChain = await observeDayfiTreasuryOnChain();
  if (getStellarSettlementMode() === 'live') {
    if (!onChain) {
      throw new InfraTreasuryError(
        'Unable to read treasury balance from Horizon',
        'HORIZON_UNAVAILABLE',
        503
      );
    }
    if (onChain.usdc + 1e-9 < Number(row.amount)) {
      throw new InfraTreasuryError(
        `Insufficient treasury USDC (have ${onChain.usdc}, need ${row.amount})`,
        'INSUFFICIENT_TREASURY_USDC'
      );
    }
    if (onChain.xlm < 0.1) {
      throw new InfraTreasuryError(
        'Insufficient treasury XLM for network fees',
        'INSUFFICIENT_TREASURY_XLM'
      );
    }
  }

  const issuer = resolveUsdcIssuer(getStellarConfig().isTestnet);
  // Wrong asset guard — only USDC rebalances supported.
  if (row.asset !== 'USDC') {
    throw new InfraTreasuryError('Only USDC rebalances are supported', 'WRONG_ASSET');
  }

  try {
    if (!secret && getStellarSettlementMode() === 'live') {
      throw new InfraTreasuryError(
        'Treasury signing secret is not configured',
        'TREASURY_SECRET_MISSING',
        503
      );
    }

    const payment = await submitUsdcPayment({
      sourceSecret: secret || undefined,
      destination: row.destination_ref,
      amount: Number(row.amount),
      memo: `g:${row.id.slice(0, 24)}`,
    });

    const verified =
      getStellarSettlementMode() === 'mock'
        ? { confirmed: true, status: 'SUCCESS', ledgerSequence: 1 }
        : await verifyUsdcPayment(payment.transactionHash);

    if (!verified.confirmed) {
      await db.none(
        `UPDATE infra_treasury_rebalances SET
           status = 'failed',
           failure_reason = $2,
           external_reference = $3,
           submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          row.id,
          `Stellar transaction not confirmed (${verified.status})`,
          payment.transactionHash,
        ]
      );
      throw new InfraTreasuryError(
        'Stellar rebalance submitted but not confirmed',
        'STELLAR_UNCONFIRMED',
        502
      );
    }

    let feeXlm: string | null =
      (payment as { actualNetworkFeeXlm?: string }).actualNetworkFeeXlm || null;
    if (!feeXlm && getStellarSettlementMode() === 'live') {
      try {
        const cfg = getStellarConfig();
        const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
        const tx = await server
          .transactions()
          .transaction(payment.transactionHash)
          .call();
        if (tx.fee_charged != null) {
          const stroops = BigInt(String(Math.trunc(Number(tx.fee_charged))));
          const whole = stroops / BigInt(10000000);
          const frac = (stroops % BigInt(10000000))
            .toString()
            .padStart(7, '0')
            .replace(/0+$/, '');
          feeXlm = frac ? `${whole.toString()}.${frac}` : whole.toString();
        }
      } catch {
        feeXlm = null;
      }
    }
    if (!feeXlm && getStellarSettlementMode() === 'mock') {
      feeXlm = '0.00001';
    }

    const confirmed = await db.one<RebalanceRow>(
      `UPDATE infra_treasury_rebalances SET
         status = 'confirmed',
         external_reference = $2,
         failure_reason = NULL,
         submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),
         confirmed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP,
         rail_metadata = COALESCE(rail_metadata, '{}'::jsonb) || $3::jsonb
       WHERE id = $1
       RETURNING id::text AS id, environment, asset, source_kind, destination_kind,
         source_ref, destination_ref, amount::text, status, purpose, external_reference, rail,
         rail_metadata, failure_reason, idempotency_key, requested_by,
         liabilities_snapshot::text, liquidity_snapshot::text, shortfall_snapshot::text,
         submitted_at, confirmed_at, created_at, updated_at`,
      [
        row.id,
        payment.transactionHash,
        JSON.stringify({
          purpose: 'treasury_rebalance',
          stellar: {
            transactionHash: payment.transactionHash,
            ledgerSequence: verified.ledgerSequence ?? payment.ledgerSequence,
            source: payment.sourceAccount,
            destination: payment.destinationAccount,
            amount: payment.amount,
            asset: 'USDC',
            issuer,
          },
          actualNetworkFeeXlm: feeXlm,
          usdcIssuer: issuer,
        }),
      ]
    );

    return {
      ...mapRebalance(confirmed),
      actualNetworkFeeXlm: feeXlm,
    };
  } catch (err: any) {
    if (err instanceof InfraTreasuryError) throw err;
    const message =
      err instanceof StellarSettlementAdapterError
        ? err.message
        : err?.message || 'Stellar rebalance failed';
    await db.none(
      `UPDATE infra_treasury_rebalances SET
         status = 'failed',
         failure_reason = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status NOT IN ('confirmed')`,
      [row.id, message]
    );
    throw new InfraTreasuryError(message, 'STELLAR_SUBMIT_FAILED', 502);
  }
}

/**
 * Operator helper: request (auto-approve) + submit in one idempotent call.
 */
export async function executeTreasuryRebalance(input: {
  environment?: InfraEnvironment | string;
  amount: number;
  destinationPublicKey: string;
  idempotencyKey: string;
  requestedBy?: string;
  purpose?: string;
}): Promise<
  ReturnType<typeof mapRebalance> & {
    duplicate?: boolean;
    actualNetworkFeeXlm?: string | null;
  }
> {
  const requested = await requestTreasuryRebalance({
    ...input,
    autoApprove: true,
  });
  if (requested.status === 'confirmed') {
    return {
      ...requested,
      duplicate: true,
      actualNetworkFeeXlm:
        (requested.railMetadata?.actualNetworkFeeXlm as string) || null,
    };
  }
  if (requested.status === 'requested') {
    await approveTreasuryRebalance({
      rebalanceId: requested.id,
      environment: String(input.environment || 'test'),
    });
  }
  return submitTreasuryRebalance({
    rebalanceId: requested.id,
    environment: String(input.environment || 'test'),
  });
}

export async function getTreasuryRebalance(id: string) {
  const row = await db.oneOrNone<RebalanceRow>(
    `${REBALANCE_SELECT} WHERE id = $1`,
    [id]
  );
  if (!row) {
    throw new InfraTreasuryError('Rebalance not found', 'NOT_FOUND', 404);
  }
  return mapRebalance(row);
}

export async function listTreasuryRebalances(input?: {
  environment?: string;
  limit?: number;
}) {
  const environment = String(input?.environment || 'test');
  const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 200);
  const rows = await db.manyOrNone<RebalanceRow>(
    `${REBALANCE_SELECT}
     WHERE environment = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [environment, limit]
  );
  return rows.map(mapRebalance);
}
