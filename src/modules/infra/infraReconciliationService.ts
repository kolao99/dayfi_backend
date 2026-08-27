/**
 * Phase 6 — Reconciliation (observe only).
 *
 * Joins Provider + Dayfi Ledger + Settlement for each payment/payout.
 * Never credits, debits, locks, or mutates settlement.
 */

import { db } from '../../config/database';
import { getInfraStellarFundingMode } from './infraStellarFundingService';

export type InfraEnv = 'test' | 'live';
export type ReconRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ReconItemStatus = 'reconciled' | 'mismatch' | 'incomplete' | 'skipped';

export type ReconResultCode =
  | 'RECONCILED'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'ASSET_MISMATCH'
  | 'MISSING_PROVIDER'
  | 'MISSING_LEDGER'
  | 'MISSING_SETTLEMENT'
  | 'PROVIDER_FAILED'
  | 'SETTLEMENT_FAILED'
  | 'SETTLEMENT_PENDING'
  | 'LEDGER_PENDING'
  | 'INCOMPLETE';

export class InfraReconciliationError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraReconciliationError';
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
  status: string;
  method: string | null;
  direction: string;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
};

type LedgerRow = {
  id: string;
  amount: string;
  asset: string;
  movement_type: string;
};

type SettlementRow = {
  id: string;
  rail: string;
  asset: string;
  amount: string;
  status: string;
  external_reference: string | null;
};

type ProviderLeg = {
  present: boolean;
  name: string | null;
  reference: string | null;
  status: string | null;
  amount: number | null;
  ok: boolean;
};

type LedgerLeg = {
  present: boolean;
  movementId: string | null;
  status: string | null;
  amount: number | null;
  asset: string | null;
  ok: boolean;
};

type SettlementLeg = {
  required: boolean;
  applicable: boolean;
  present: boolean;
  settlementId: string | null;
  rail: string | null;
  status: string | null;
  amount: number | null;
  externalReference: string | null;
  ok: boolean;
};

export type ReconCheckResult = {
  transactionId: string;
  direction: 'payment' | 'payout' | 'deposit' | 'internal_transfer';
  status: ReconItemStatus;
  resultCode: ReconResultCode;
  asset: string;
  expectedAmount: number | null;
  provider: ProviderLeg;
  ledger: LedgerLeg;
  settlement: SettlementLeg;
  mismatches: ReconResultCode[];
  legs: Record<string, unknown>;
  note: string | null;
};

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e7) / 1e7 : null;
}

function amountsEqual(a: number | null, b: number | null, eps = 1e-6): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}

function isProviderConfirmed(status: string | null): boolean {
  const s = String(status || '').toLowerCase();
  return ['settled', 'completed', 'success', 'confirmed', 'paid'].includes(s);
}

function isProviderFailed(status: string | null): boolean {
  const s = String(status || '').toLowerCase();
  return ['failed', 'cancelled', 'canceled', 'rejected', 'expired'].includes(s);
}

function expectedUsdc(tx: TxRow): number | null {
  const m = tx.metadata || {};
  return num(m.usdcAmount ?? m.ledgerAmount ?? m.settlementUsdc ?? m.usdc_amount) ?? num(tx.amount);
}

function isStellarNativeDeposit(tx: TxRow): boolean {
  const m = tx.metadata || {};
  return (
    tx.direction === 'deposit' || String(m.type || '') === 'stellar_deposit'
  );
}

function isInternalTransfer(tx: TxRow): boolean {
  const m = tx.metadata || {};
  return (
    tx.direction === 'internal_transfer' ||
    String(m.type || '') === 'internal_transfer' ||
    String(tx.method || '') === 'internal_transfer'
  );
}

function observeProvider(tx: TxRow): ProviderLeg {
  // Increment D: crypto deposits have no fiat provider rail.
  // Increment E: internal transfers have no provider rail.
  if (isStellarNativeDeposit(tx) || isInternalTransfer(tx)) {
    return {
      present: false,
      name: null,
      reference: null,
      status: 'not_applicable',
      amount: expectedUsdc(tx),
      ok: true,
    };
  }

  const m = tx.metadata || {};
  const name =
    (typeof m.provider === 'string' && m.provider) ||
    (typeof m.settlementSource === 'string' && m.settlementSource) ||
    (tx.external_id ? 'provider' : null);

  const reference =
    (typeof m.providerEventId === 'string' && m.providerEventId) ||
    tx.external_id ||
    (typeof m.sequenceId === 'string' && m.sequenceId) ||
    null;

  const status = String(tx.status || '').toLowerCase() || null;
  const amount = expectedUsdc(tx);
  const present = Boolean(
    reference ||
      m.providerEventId ||
      m.settlementSource ||
      isProviderConfirmed(status) ||
      isProviderFailed(status)
  );
  const ok = present && isProviderConfirmed(status) && !isProviderFailed(status);

  return {
    present,
    name: name ? String(name) : null,
    reference: reference ? String(reference) : null,
    status,
    amount,
    ok,
  };
}

async function observeLedger(tx: TxRow): Promise<LedgerLeg> {
  if (isInternalTransfer(tx)) {
    const m = tx.metadata || {};
    const movementType =
      String(m.role || '') === 'recipient'
        ? 'internal_transfer_credit'
        : 'internal_transfer_debit';
    const row = await db.oneOrNone<LedgerRow>(
      `SELECT id::text AS id, amount::text, asset, movement_type
       FROM infra_ledger_movements
       WHERE org_id = $1 AND environment = $2 AND reference_id = $3
         AND movement_type = $4
       ORDER BY created_at DESC LIMIT 1`,
      [tx.org_id, tx.environment, tx.id, movementType]
    );
    if (row) {
      return {
        present: true,
        movementId: row.id,
        status: movementType === 'internal_transfer_credit' ? 'CREDITED' : 'DEBITED',
        amount: num(row.amount),
        asset: row.asset || 'USDC',
        ok: true,
      };
    }
    return {
      present: false,
      movementId: null,
      status: 'MISSING',
      amount: null,
      asset: null,
      ok: false,
    };
  }

  if (tx.direction === 'deposit' || isStellarNativeDeposit(tx)) {
    const creditRow = await db.oneOrNone<LedgerRow>(
      `SELECT id::text AS id, amount::text, asset, movement_type
       FROM infra_ledger_movements
       WHERE org_id = $1 AND environment = $2 AND reference_id = $3
         AND movement_type = 'deposit_credit'
       ORDER BY created_at DESC LIMIT 1`,
      [tx.org_id, tx.environment, tx.id]
    );
    if (creditRow) {
      return {
        present: true,
        movementId: creditRow.id,
        status: 'AVAILABLE',
        amount: num(creditRow.amount),
        asset: creditRow.asset || 'USDC',
        ok: true,
      };
    }

    const pendingRow = await db.oneOrNone<LedgerRow>(
      `SELECT id::text AS id, amount::text, asset, movement_type
       FROM infra_ledger_movements
       WHERE org_id = $1 AND environment = $2 AND reference_id = $3
         AND movement_type = 'deposit_pending'
       ORDER BY created_at DESC LIMIT 1`,
      [tx.org_id, tx.environment, tx.id]
    );
    if (pendingRow) {
      return {
        present: true,
        movementId: pendingRow.id,
        status: 'PENDING_DEPOSIT',
        amount: num(pendingRow.amount),
        asset: pendingRow.asset || 'USDC',
        ok: false,
      };
    }

    return {
      present: false,
      movementId: null,
      status: 'MISSING',
      amount: null,
      asset: null,
      ok: false,
    };
  }

  if (tx.direction === 'payment') {
    const creditRow = await db.oneOrNone<LedgerRow>(
      `SELECT id::text AS id, amount::text, asset, movement_type
       FROM infra_ledger_movements
       WHERE org_id = $1 AND environment = $2 AND reference_id = $3
         AND movement_type = 'collection_credit'
       ORDER BY created_at DESC LIMIT 1`,
      [tx.org_id, tx.environment, tx.id]
    );
    if (creditRow) {
      return {
        present: true,
        movementId: creditRow.id,
        status: 'AVAILABLE',
        amount: num(creditRow.amount),
        asset: creditRow.asset || 'USDC',
        ok: true,
      };
    }

    const pendingRow = await db.oneOrNone<LedgerRow>(
      `SELECT id::text AS id, amount::text, asset, movement_type
       FROM infra_ledger_movements
       WHERE org_id = $1 AND environment = $2 AND reference_id = $3
         AND movement_type = 'collection_pending'
       ORDER BY created_at DESC LIMIT 1`,
      [tx.org_id, tx.environment, tx.id]
    );
    if (pendingRow) {
      return {
        present: true,
        movementId: pendingRow.id,
        status: 'PENDING_FUNDING',
        amount: num(pendingRow.amount),
        asset: pendingRow.asset || 'USDC',
        ok: false,
      };
    }

    return {
      present: false,
      movementId: null,
      status: 'MISSING',
      amount: null,
      asset: null,
      ok: false,
    };
  }

  const movementType = 'payout_settle';

  const row = await db.oneOrNone<LedgerRow>(
    `SELECT id::text AS id, amount::text, asset, movement_type
     FROM infra_ledger_movements
     WHERE org_id = $1
       AND environment = $2
       AND reference_id = $3
       AND movement_type = $4
     ORDER BY created_at DESC
     LIMIT 1`,
    [tx.org_id, tx.environment, tx.id, movementType]
  );

  if (!row) {
    const m = tx.metadata || {};
    const locked =
      m.fundsLocked === true ||
      m.funds_locked === true ||
      Boolean(m.ledgerLockId);
    const finalized =
      m.fundsFinalized === true || m.funds_finalized === true;
    if (tx.direction === 'payout' && locked && !finalized) {
      return {
        present: false,
        movementId: null,
        status: 'LOCKED',
        amount: expectedUsdc(tx),
        asset: 'USDC',
        ok: false,
      };
    }
    return {
      present: false,
      movementId: null,
      status: 'MISSING',
      amount: null,
      asset: null,
      ok: false,
    };
  }

  return {
    present: true,
    movementId: row.id,
    status: tx.direction === 'payment' ? 'CREDITED' : 'DEBITED',
    amount: num(row.amount),
    asset: row.asset || 'USDC',
    ok: true,
  };
}

function isOnchainInternalTransfer(tx: TxRow): boolean {
  const m = tx.metadata || {};
  return (
    isInternalTransfer(tx) &&
    (String(m.settlementMode || '') === 'STELLAR_ONCHAIN' ||
      String(m.settlementRail || '').toUpperCase() === 'STELLAR')
  );
}

async function observeSettlement(tx: TxRow): Promise<SettlementLeg> {
  if (isInternalTransfer(tx) && !isOnchainInternalTransfer(tx)) {
    return {
      required: false,
      applicable: false,
      present: false,
      settlementId: null,
      rail: null,
      status: 'NOT_APPLICABLE',
      amount: null,
      externalReference: null,
      ok: true,
    };
  }

  const m = tx.metadata || {};

  // Increment H: dual-leg offramp — STELLAR (treasury) + PROVIDER must both confirm.
  if (m.offRamp === true && tx.direction === 'payout') {
    const legs = await db.manyOrNone<SettlementRow>(
      `SELECT id::text AS id, rail, asset, amount::text, status,
              external_reference
       FROM infra_settlements
       WHERE payout_transaction_id = $1 AND org_id = $2
       ORDER BY created_at ASC`,
      [tx.id, tx.org_id]
    );
    const stellar = legs.find((l) => String(l.rail).toUpperCase() === 'STELLAR');
    const provider = legs.find((l) =>
      ['YELLOW_CARD', 'PROVIDER'].includes(String(l.rail).toUpperCase())
    );
    const stellarOk = String(stellar?.status || '').toLowerCase() === 'confirmed';
    const providerOk = String(provider?.status || '').toLowerCase() === 'confirmed';
    const providerFailed = String(provider?.status || '').toLowerCase() === 'failed';
    const present = Boolean(stellar || provider);
    let status = 'MISSING';
    if (stellarOk && providerOk) status = 'CONFIRMED';
    else if (providerFailed && stellarOk) status = 'PROVIDER_ACTION_REQUIRED';
    else if (stellarOk) status = 'SETTLEMENT_PENDING';
    else if (stellar) status = String(stellar.status || 'PENDING').toUpperCase();
    return {
      required: true,
      applicable: true,
      present,
      settlementId: stellar?.id || provider?.id || null,
      rail: 'STELLAR+PROVIDER',
      status,
      amount: stellar ? num(stellar.amount) : null,
      externalReference: stellar?.external_reference || provider?.external_reference || null,
      ok: stellarOk && providerOk,
    };
  }

  const method = String(tx.method || '').toLowerCase();
  const network = String(m.network || m.cryptoNetwork || '').toLowerCase();
  const walletFunding = (m.walletFunding || {}) as Record<string, unknown>;
  const hasStellarMeta =
    Boolean(m.stellarTransactionHash) ||
    Boolean(m.settlementId) ||
    Boolean(walletFunding.stellarTransactionHash) ||
    Boolean(walletFunding.settlementId) ||
    String(m.settlementRail || '').toUpperCase() === 'STELLAR';

  let settlement = await db.oneOrNone<SettlementRow>(
    `SELECT id::text AS id, rail, asset, amount::text, status,
            external_reference
     FROM infra_settlements
     WHERE payout_transaction_id = $1
       AND org_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [tx.id, tx.org_id]
  );

  if (!settlement && (tx.direction === 'payment' || isOnchainInternalTransfer(tx))) {
    settlement = await db.oneOrNone<SettlementRow>(
      `SELECT id::text AS id, rail, asset, amount::text, status,
              external_reference
       FROM infra_settlements
       WHERE collection_transaction_id = $1
         AND (org_id = $2 OR $3::boolean)
       ORDER BY created_at DESC
       LIMIT 1`,
      [tx.id, tx.org_id, isOnchainInternalTransfer(tx)]
    );
  }

  // Increment D: deposit settlement evidence lives on infra_stellar_deposits.
  if (!settlement && (tx.direction === 'deposit' || isStellarNativeDeposit(tx))) {
    const deposit = await db.oneOrNone<{
      id: string;
      amount: string;
      status: string;
      stellar_tx_hash: string;
    }>(
      `SELECT id::text AS id, amount::text, status, stellar_tx_hash
       FROM infra_stellar_deposits
       WHERE transaction_id = $1 AND org_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [tx.id, tx.org_id]
    );
    if (deposit) {
      const st = String(deposit.status).toLowerCase();
      return {
        required: true,
        applicable: true,
        present: true,
        settlementId: deposit.id,
        rail: 'STELLAR',
        status: st === 'confirmed' ? 'CONFIRMED' : st.toUpperCase(),
        amount: num(deposit.amount),
        externalReference: deposit.stellar_tx_hash,
        ok: st === 'confirmed',
      };
    }
    return {
      required: true,
      applicable: true,
      present: false,
      settlementId: null,
      rail: 'STELLAR',
      status: 'MISSING',
      amount: null,
      externalReference: null,
      ok: false,
    };
  }

  const fundingMode = getInfraStellarFundingMode();
  const collectionFundingExpected =
    tx.direction === 'payment' &&
    (fundingMode !== 'off' ||
      Boolean(settlement) ||
      Boolean(walletFunding.mode) ||
      Boolean(walletFunding.status));

  const required =
    Boolean(settlement) ||
    hasStellarMeta ||
    collectionFundingExpected ||
    (tx.direction === 'payout' &&
      (method === 'crypto' || network === 'stellar' || network.includes('stellar')));

  if (!required) {
    return {
      required: false,
      applicable: false,
      present: false,
      settlementId: null,
      rail: null,
      status: 'NOT_APPLICABLE',
      amount: null,
      externalReference: null,
      ok: true,
    };
  }

  if (collectionFundingExpected && tx.direction === 'payment' && !settlement) {
    return {
      required: true,
      applicable: true,
      present: false,
      settlementId: null,
      rail: 'STELLAR',
      status: 'MISSING',
      amount: null,
      externalReference: null,
      ok: false,
    };
  }

  if (!settlement) {
    return {
      required: true,
      applicable: true,
      present: false,
      settlementId: null,
      rail: 'STELLAR',
      status: 'MISSING',
      amount: null,
      externalReference: null,
      ok: false,
    };
  }

  const st = String(settlement.status).toLowerCase();
  return {
    required: true,
    applicable: true,
    present: true,
    settlementId: settlement.id,
    rail: settlement.rail,
    status: st.toUpperCase(),
    amount: num(settlement.amount),
    externalReference: settlement.external_reference,
    ok: st === 'confirmed',
  };
}

function classify(
  provider: ProviderLeg,
  ledger: LedgerLeg,
  settlement: SettlementLeg,
  expectedAmount: number | null,
  opts?: { skipProvider?: boolean }
): {
  status: ReconItemStatus;
  resultCode: ReconResultCode;
  mismatches: ReconResultCode[];
  note: string | null;
} {
  const mismatches: ReconResultCode[] = [];

  if (!opts?.skipProvider) {
    if (isProviderFailed(provider.status)) {
      mismatches.push('PROVIDER_FAILED');
    } else if (!provider.present) {
      mismatches.push('MISSING_PROVIDER');
    } else if (!isProviderConfirmed(provider.status)) {
      mismatches.push('STATUS_MISMATCH');
    }
  }

  if (!ledger.present) {
    if (ledger.status === 'LOCKED' || ledger.status === 'PENDING_DEPOSIT') {
      mismatches.push('LEDGER_PENDING');
    } else mismatches.push('MISSING_LEDGER');
  } else if (
    ledger.status === 'PENDING_DEPOSIT' ||
    ledger.status === 'PENDING_FUNDING'
  ) {
    mismatches.push('LEDGER_PENDING');
  }

  if (settlement.applicable && settlement.required) {
    if (!settlement.present) {
      mismatches.push('MISSING_SETTLEMENT');
    } else {
      const st = String(settlement.status || '').toLowerCase();
      if (st === 'failed' || st === 'cancelled' || st === 'rejected') {
        mismatches.push('SETTLEMENT_FAILED');
      } else if (st === 'provider_action_required') {
        mismatches.push('SETTLEMENT_FAILED');
      } else if (st === 'pending_treasury') {
        mismatches.push('SETTLEMENT_PENDING');
      } else if (
        st === 'pending' ||
        st === 'submitted' ||
        st === 'detected' ||
        st === 'verified' ||
        st === 'pending_ledger' ||
        st === 'settlement_pending'
      ) {
        mismatches.push('SETTLEMENT_PENDING');
      } else if (!settlement.ok) {
        mismatches.push('STATUS_MISMATCH');
      }
    }
  }

  const presentAmounts: number[] = [];
  if (expectedAmount != null) presentAmounts.push(expectedAmount);
  if (provider.present && provider.amount != null) presentAmounts.push(provider.amount);
  if (ledger.present && ledger.amount != null) presentAmounts.push(ledger.amount);
  if (settlement.applicable && settlement.present && settlement.amount != null) {
    presentAmounts.push(settlement.amount);
  }
  if (presentAmounts.length >= 2) {
    const base = presentAmounts[0];
    if (presentAmounts.some((a) => !amountsEqual(a, base))) {
      mismatches.push('AMOUNT_MISMATCH');
    }
  }

  if (ledger.present && ledger.asset && ledger.asset.toUpperCase() !== 'USDC') {
    mismatches.push('ASSET_MISMATCH');
  }

  const unique = [...new Set(mismatches)];
  if (unique.length === 0) {
    return {
      status: 'reconciled',
      resultCode: 'RECONCILED',
      mismatches: [],
      note: null,
    };
  }

  const priority: ReconResultCode[] = [
    'AMOUNT_MISMATCH',
    'ASSET_MISMATCH',
    'PROVIDER_FAILED',
    'SETTLEMENT_FAILED',
    'MISSING_PROVIDER',
    'MISSING_LEDGER',
    'MISSING_SETTLEMENT',
    'SETTLEMENT_PENDING',
    'LEDGER_PENDING',
    'STATUS_MISMATCH',
    'INCOMPLETE',
  ];
  const resultCode =
    priority.find((c) => unique.includes(c)) || ('INCOMPLETE' as ReconResultCode);

  const incompleteCodes: ReconResultCode[] = [
    'MISSING_PROVIDER',
    'MISSING_LEDGER',
    'MISSING_SETTLEMENT',
    'SETTLEMENT_PENDING',
    'LEDGER_PENDING',
    'INCOMPLETE',
  ];

  return {
    status: incompleteCodes.includes(resultCode) ? 'incomplete' : 'mismatch',
    resultCode,
    mismatches: unique,
    note: unique.join(', '),
  };
}

function buildLegs(
  provider: ProviderLeg,
  ledger: LedgerLeg,
  settlement: SettlementLeg,
  outcome: ReturnType<typeof classify>
): Record<string, unknown> {
  return {
    provider: {
      status: provider.status ? String(provider.status).toUpperCase() : null,
      amount: provider.amount,
      reference: provider.reference,
      name: provider.name,
      present: provider.present,
      ok: provider.ok,
    },
    ledger: {
      status: ledger.status,
      amount: ledger.amount,
      movementId: ledger.movementId,
      present: ledger.present,
      ok: ledger.ok,
    },
    settlement: {
      required: settlement.required,
      applicable: settlement.applicable,
      status: settlement.status,
      rail: settlement.rail,
      amount: settlement.amount,
      reference: settlement.externalReference,
      settlementId: settlement.settlementId,
      present: settlement.present,
      ok: settlement.ok,
    },
    result: {
      status: outcome.status,
      code: outcome.resultCode,
      mismatches: outcome.mismatches,
    },
  };
}

export async function reconcileTransaction(tx: TxRow): Promise<ReconCheckResult> {
  const provider = observeProvider(tx);
  const ledger = await observeLedger(tx);
  const settlement = await observeSettlement(tx);
  const expectedAmount = expectedUsdc(tx);
  const outcome = classify(provider, ledger, settlement, expectedAmount, {
    skipProvider: isStellarNativeDeposit(tx) || isInternalTransfer(tx),
  });
  const legs = buildLegs(provider, ledger, settlement, outcome);

  const direction: ReconCheckResult['direction'] =
    tx.direction === 'payout'
      ? 'payout'
      : tx.direction === 'deposit' || isStellarNativeDeposit(tx)
        ? 'deposit'
        : isInternalTransfer(tx)
          ? 'internal_transfer'
          : 'payment';

  return {
    transactionId: tx.id,
    direction,
    status: outcome.status,
    resultCode: outcome.resultCode,
    asset: 'USDC',
    expectedAmount,
    provider,
    ledger,
    settlement,
    mismatches: outcome.mismatches,
    legs,
    note: outcome.note,
  };
}

function mapRun(row: Record<string, any>) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment,
    status: row.status as ReconRunStatus,
    triggerSource: row.trigger_source,
    scope: row.scope || {},
    idempotencyKey: row.idempotency_key,
    summary: row.summary || {},
    failureReason: row.failure_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function mapItem(row: Record<string, any>) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment,
    runId: row.run_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    status: row.status as ReconItemStatus,
    resultCode: row.result_code as ReconResultCode,
    asset: row.asset,
    expectedAmount: num(row.expected_amount),
    provider: {
      present: row.provider_present,
      name: row.provider_name,
      reference: row.provider_reference,
      status: row.provider_status,
      amount: num(row.provider_amount),
    },
    ledger: {
      present: row.ledger_present,
      movementId: row.ledger_movement_id,
      status: row.ledger_status,
      amount: num(row.ledger_amount),
    },
    settlement: {
      required: row.settlement_required,
      present: row.settlement_present,
      settlementId: row.settlement_id,
      rail: row.settlement_rail,
      status: row.settlement_status,
      amount: num(row.settlement_amount),
      externalReference: row.settlement_external_reference,
    },
    legs: row.legs || {},
    mismatches: Array.isArray(row.mismatches) ? row.mismatches : [],
    note: row.note,
    createdAt: row.created_at,
  };
}

const RUN_SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment, status,
  trigger_source, scope, idempotency_key, summary, failure_reason,
  started_at, completed_at, created_at
 FROM infra_reconciliation_runs`;

const ITEM_SELECT = `SELECT id::text AS id, org_id::text AS org_id, environment,
  run_id::text AS run_id, transaction_id::text AS transaction_id, direction,
  status, result_code, asset, expected_amount::text,
  provider_present, provider_name, provider_reference, provider_status,
  provider_amount::text,
  ledger_present, ledger_movement_id::text AS ledger_movement_id,
  ledger_status, ledger_amount::text,
  settlement_required, settlement_present,
  settlement_id::text AS settlement_id, settlement_rail, settlement_status,
  settlement_amount::text, settlement_external_reference,
  legs, mismatches, note, created_at
 FROM infra_reconciliation_items`;

async function loadTransactions(input: {
  orgId: string;
  env: InfraEnv;
  direction?: 'payment' | 'payout';
  transactionIds?: string[];
}): Promise<TxRow[]> {
  const params: unknown[] = [input.orgId, input.env];
  let sql = `SELECT id::text AS id, org_id::text AS org_id, environment,
                    amount::text, currency, status, method, direction,
                    external_id, metadata
             FROM infra_transactions
             WHERE org_id = $1 AND environment = $2
               AND direction IN ('payment', 'payout', 'deposit', 'internal_transfer')`;

  if (input.direction) {
    params.push(input.direction);
    sql += ` AND direction = $${params.length}`;
  }
  if (input.transactionIds?.length) {
    params.push(input.transactionIds);
    sql += ` AND id = ANY($${params.length}::uuid[])`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 500`;
  return db.manyOrNone<TxRow>(sql, params).then((rows) => rows || []);
}

async function persistItem(
  orgId: string,
  env: InfraEnv,
  runId: string,
  check: ReconCheckResult
): Promise<void> {
  await db.none(
    `INSERT INTO infra_reconciliation_items (
       org_id, environment, run_id, transaction_id, direction,
       status, result_code, asset, expected_amount,
       provider_present, provider_name, provider_reference, provider_status, provider_amount,
       ledger_present, ledger_movement_id, ledger_status, ledger_amount,
       settlement_required, settlement_present, settlement_id, settlement_rail,
       settlement_status, settlement_amount, settlement_external_reference,
       legs, mismatches, note
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8,$9,
       $10,$11,$12,$13,$14,
       $15,$16,$17,$18,
       $19,$20,$21,$22,
       $23,$24,$25,
       $26::jsonb,$27::jsonb,$28
     )
     ON CONFLICT (run_id, transaction_id) DO UPDATE SET
       status = EXCLUDED.status,
       result_code = EXCLUDED.result_code,
       expected_amount = EXCLUDED.expected_amount,
       provider_present = EXCLUDED.provider_present,
       provider_name = EXCLUDED.provider_name,
       provider_reference = EXCLUDED.provider_reference,
       provider_status = EXCLUDED.provider_status,
       provider_amount = EXCLUDED.provider_amount,
       ledger_present = EXCLUDED.ledger_present,
       ledger_movement_id = EXCLUDED.ledger_movement_id,
       ledger_status = EXCLUDED.ledger_status,
       ledger_amount = EXCLUDED.ledger_amount,
       settlement_required = EXCLUDED.settlement_required,
       settlement_present = EXCLUDED.settlement_present,
       settlement_id = EXCLUDED.settlement_id,
       settlement_rail = EXCLUDED.settlement_rail,
       settlement_status = EXCLUDED.settlement_status,
       settlement_amount = EXCLUDED.settlement_amount,
       settlement_external_reference = EXCLUDED.settlement_external_reference,
       legs = EXCLUDED.legs,
       mismatches = EXCLUDED.mismatches,
       note = EXCLUDED.note`,
    [
      orgId,
      env,
      runId,
      check.transactionId,
      check.direction,
      check.status,
      check.resultCode,
      check.asset,
      check.expectedAmount,
      check.provider.present,
      check.provider.name,
      check.provider.reference,
      check.provider.status,
      check.provider.amount,
      check.ledger.present,
      check.ledger.movementId,
      check.ledger.status,
      check.ledger.amount,
      check.settlement.required,
      check.settlement.present,
      check.settlement.settlementId,
      check.settlement.rail,
      check.settlement.status,
      check.settlement.amount,
      check.settlement.externalReference,
      JSON.stringify(check.legs),
      JSON.stringify(check.mismatches),
      check.note,
    ]
  );
}

/**
 * Run reconciliation for an org (idempotent by idempotencyKey).
 * Observes only — does not mutate ledger or settlements.
 */
export async function runReconciliation(input: {
  orgId: string;
  environment?: string;
  direction?: 'payment' | 'payout';
  transactionIds?: string[];
  idempotencyKey?: string;
  triggerSource?: 'api' | 'manual' | 'scheduled' | 'test';
}) {
  const env = asEnv(input.environment || 'test');
  const idempotencyKey =
    input.idempotencyKey ||
    `recon:${env}:${input.direction || 'all'}:${Date.now()}`;

  const existing = await db.oneOrNone(
    `${RUN_SELECT} WHERE org_id = $1 AND idempotency_key = $2`,
    [input.orgId, idempotencyKey]
  );
  if (existing?.status === 'completed') {
    const items = await db.manyOrNone(
      `${ITEM_SELECT} WHERE run_id = $1 ORDER BY created_at DESC`,
      [existing.id]
    );
    return {
      run: mapRun(existing),
      items: (items || []).map(mapItem),
      duplicate: true,
    };
  }

  const scope = {
    direction: input.direction || null,
    transactionIds: input.transactionIds || null,
  };

  let run = existing;
  if (!run) {
    run = await db.one(
      `INSERT INTO infra_reconciliation_runs
         (org_id, environment, status, trigger_source, scope, idempotency_key, started_at)
       VALUES ($1, $2, 'running', $3, $4::jsonb, $5, CURRENT_TIMESTAMP)
       RETURNING id::text AS id, org_id::text AS org_id, environment, status,
                 trigger_source, scope, idempotency_key, summary, failure_reason,
                 started_at, completed_at, created_at`,
      [
        input.orgId,
        env,
        input.triggerSource || 'api',
        JSON.stringify(scope),
        idempotencyKey,
      ]
    );
  } else {
    await db.none(
      `UPDATE infra_reconciliation_runs
       SET status = 'running', started_at = CURRENT_TIMESTAMP, failure_reason = NULL
       WHERE id = $1`,
      [run.id]
    );
    run = await db.one(`${RUN_SELECT} WHERE id = $1`, [run.id]);
  }

  try {
    const txs = await loadTransactions({
      orgId: input.orgId,
      env,
      direction: input.direction,
      transactionIds: input.transactionIds,
    });

    const checks: ReconCheckResult[] = [];
    for (const tx of txs) {
      const check = await reconcileTransaction(tx);
      await persistItem(input.orgId, env, run.id, check);
      checks.push(check);
    }

    const summary = {
      total: checks.length,
      reconciled: checks.filter((c) => c.status === 'reconciled').length,
      mismatch: checks.filter((c) => c.status === 'mismatch').length,
      incomplete: checks.filter((c) => c.status === 'incomplete').length,
      skipped: checks.filter((c) => c.status === 'skipped').length,
      byCode: checks.reduce<Record<string, number>>((acc, c) => {
        acc[c.resultCode] = (acc[c.resultCode] || 0) + 1;
        return acc;
      }, {}),
    };

    await db.none(
      `UPDATE infra_reconciliation_runs
       SET status = 'completed',
           summary = $2::jsonb,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [run.id, JSON.stringify(summary)]
    );

    const completed = await db.one(`${RUN_SELECT} WHERE id = $1`, [run.id]);
    const items = await db.manyOrNone(
      `${ITEM_SELECT} WHERE run_id = $1 ORDER BY created_at DESC`,
      [run.id]
    );

    return {
      run: mapRun(completed),
      items: (items || []).map(mapItem),
      duplicate: false,
    };
  } catch (err: any) {
    await db.none(
      `UPDATE infra_reconciliation_runs
       SET status = 'failed',
           failure_reason = $2,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [run.id, err?.message || String(err)]
    );
    throw err;
  }
}

export async function getReconciliationRun(orgId: string, runId: string) {
  const run = await db.oneOrNone(
    `${RUN_SELECT} WHERE id = $1 AND org_id = $2`,
    [runId, orgId]
  );
  if (!run) {
    throw new InfraReconciliationError(
      'Reconciliation run not found',
      'NOT_FOUND',
      404
    );
  }
  const items = await db.manyOrNone(
    `${ITEM_SELECT} WHERE run_id = $1 ORDER BY created_at DESC`,
    [runId]
  );
  return { run: mapRun(run), items: (items || []).map(mapItem) };
}

export async function listReconciliationRuns(
  orgId: string,
  env: string,
  opts?: { limit?: number }
) {
  const limit = Math.min(Math.max(opts?.limit || 50, 1), 200);
  const rows = await db.manyOrNone(
    `${RUN_SELECT}
     WHERE org_id = $1 AND environment = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [orgId, asEnv(env), limit]
  );
  return (rows || []).map(mapRun);
}

export async function listReconciliationItems(
  orgId: string,
  env: string,
  opts?: { limit?: number; status?: string; resultCode?: string }
) {
  const limit = Math.min(Math.max(opts?.limit || 100, 1), 500);
  const params: unknown[] = [orgId, asEnv(env)];
  let sql = `${ITEM_SELECT}
    WHERE org_id = $1 AND environment = $2
      AND run_id IN (
        SELECT id FROM infra_reconciliation_runs
        WHERE org_id = $1 AND environment = $2 AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 1
      )`;

  if (opts?.status) {
    params.push(opts.status);
    sql += ` AND status = $${params.length}`;
  }
  if (opts?.resultCode) {
    params.push(opts.resultCode);
    sql += ` AND result_code = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const rows = await db.manyOrNone(sql, params);
  return (rows || []).map(mapItem);
}

export async function getReconciliationForTransaction(
  orgId: string,
  transactionId: string
) {
  const row = await db.oneOrNone(
    `${ITEM_SELECT}
     WHERE org_id = $1 AND transaction_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, transactionId]
  );

  const tx = await db.oneOrNone<TxRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment,
            amount::text, currency, status, method, direction,
            external_id, metadata
     FROM infra_transactions
     WHERE id = $1 AND org_id = $2`,
    [transactionId, orgId]
  );
  if (!tx) {
    throw new InfraReconciliationError('Transaction not found', 'NOT_FOUND', 404);
  }

  const check = await reconcileTransaction(tx);
  return {
    persisted: Boolean(row),
    item: row ? mapItem(row) : null,
    check,
  };
}

export async function getReconciliationOverview(orgId: string, env: string) {
  const environment = asEnv(env);
  const latestRun = await db.oneOrNone(
    `${RUN_SELECT}
     WHERE org_id = $1 AND environment = $2 AND status = 'completed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, environment]
  );

  if (!latestRun) {
    return {
      // Dashboard + docs use matchedPct / unmatchedPct
      matchedPct: null,
      unmatchedPct: null,
      processed: 0,
      currency: 'USDC',
      run: null,
      summary: null,
      rows: [],
    };
  }

  const items = await db.manyOrNone(
    `${ITEM_SELECT} WHERE run_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [latestRun.id]
  );
  const mapped = (items || []).map(mapItem);
  const total = mapped.length;
  const matched = mapped.filter((i) => i.status === 'reconciled').length;
  const matchedPct =
    total === 0 ? null : Math.round((matched / total) * 1000) / 10;
  const unmatchedPct =
    total === 0 ? null : Math.round(((total - matched) / total) * 1000) / 10;

  return {
    matchedPct,
    unmatchedPct,
    processed: mapped.reduce((s, i) => s + (i.expectedAmount || 0), 0),
    currency: 'USDC',
    run: mapRun(latestRun),
    summary: latestRun.summary,
    rows: mapped,
  };
}

/** Alias for existing getReconciliation callers. */
export async function getReconciliation(orgId: string, env: string) {
  return getReconciliationOverview(orgId, env);
}
