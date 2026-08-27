/**
 * Dayfi Stellar XLM fee-paying account (network-fee sponsor).
 *
 * Customers are never required to hold XLM. This account pays Stellar
 * BASE_FEE (and future fee-bumps). Secrets stay in env/custody — never
 * in org records or API responses.
 *
 * Modes:
 *   mock — tests; available XLM from DAYFI_STELLAR_FEE_PAYER_MOCK_XLM
 *   live — Horizon observation of DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY
 */

import StellarSdk from '@stellar/stellar-sdk';
import { getStellarConfig } from '../../config/stellarConfig';
import { formatXlm, parseXlmToMinor } from './infraMoneyAmount';

export class InfraFeePayerError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraFeePayerError';
    this.code = code;
    this.status = status;
  }
}

export type FeePayerMode = 'mock' | 'live';

export type StellarFeePayerView = {
  publicKey: string | null;
  network: string;
  availableXlm: string;
  minimumReserveXlm: string;
  enabled: boolean;
  sufficient: boolean;
  mode: FeePayerMode;
  /** Never a secret. */
  hasSigningMaterial: boolean;
};

export function getStellarFeePayerMode(): FeePayerMode {
  const raw = String(process.env.DAYFI_STELLAR_FEE_PAYER_MODE || '')
    .trim()
    .toLowerCase();
  if (raw === 'live' || raw === 'mock') return raw;
  return 'mock';
}

export function isStellarFeePayerEnabled(): boolean {
  const raw = String(process.env.DAYFI_STELLAR_FEE_PAYER_ENABLED || 'true')
    .trim()
    .toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function configuredPublicKey(): string | null {
  const pk = String(process.env.DAYFI_STELLAR_FEE_PAYER_PUBLIC_KEY || '').trim();
  if (/^G[A-Z0-9]{55}$/.test(pk)) return pk;
  const secret = String(process.env.DAYFI_STELLAR_FEE_PAYER_SECRET || '').trim();
  if (/^S[A-Z0-9]{55}$/.test(secret)) {
    try {
      return StellarSdk.Keypair.fromSecret(secret).publicKey();
    } catch {
      return null;
    }
  }
  return null;
}

function hasSigningMaterial(): boolean {
  const secret = String(process.env.DAYFI_STELLAR_FEE_PAYER_SECRET || '').trim();
  return /^S[A-Z0-9]{55}$/.test(secret);
}

export function getMinimumReserveXlmMinor(): bigint {
  const raw = String(process.env.DAYFI_STELLAR_FEE_PAYER_MIN_XLM || '5').trim();
  try {
    return parseXlmToMinor(raw);
  } catch {
    return parseXlmToMinor('5');
  }
}

async function observeAvailableXlmMinor(): Promise<bigint> {
  const mode = getStellarFeePayerMode();
  if (mode === 'mock') {
    const raw = String(process.env.DAYFI_STELLAR_FEE_PAYER_MOCK_XLM || '100').trim();
    return parseXlmToMinor(raw || '0');
  }

  const publicKey = configuredPublicKey();
  if (!publicKey) {
    throw new InfraFeePayerError(
      'Dayfi XLM fee-paying account is not configured',
      'FEE_PAYER_UNCONFIGURED',
      503
    );
  }

  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const native = (
      account.balances as { asset_type?: string; balance?: string }[]
    ).find((b) => b.asset_type === 'native');
    return parseXlmToMinor(native?.balance || '0');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InfraFeePayerError(
      `Unable to observe Dayfi XLM fee reserve: ${message}`.slice(0, 400),
      'FEE_PAYER_OBSERVE_FAILED',
      502
    );
  }
}

/**
 * Public observation only — never returns a secret.
 */
export async function getStellarFeePayerStatus(): Promise<StellarFeePayerView> {
  const cfg = getStellarConfig();
  const publicKey = configuredPublicKey();
  const min = getMinimumReserveXlmMinor();
  const enabled = isStellarFeePayerEnabled();
  let available = BigInt(0);
  try {
    available = await observeAvailableXlmMinor();
  } catch (err) {
    if (err instanceof InfraFeePayerError && err.code === 'FEE_PAYER_UNCONFIGURED') {
      available = BigInt(0);
    } else {
      throw err;
    }
  }
  return {
    publicKey,
    network: cfg.isTestnet ? 'testnet' : 'mainnet',
    availableXlm: formatXlm(available),
    minimumReserveXlm: formatXlm(min),
    enabled,
    sufficient: enabled && publicKey != null && available >= min,
    mode: getStellarFeePayerMode(),
    hasSigningMaterial: hasSigningMaterial(),
  };
}

/**
 * Pre-submit check for sponsored Stellar transactions.
 * Does not debit customers. Does not submit a transaction.
 */
export async function assertNetworkFeeReserve(): Promise<StellarFeePayerView> {
  const status = await getStellarFeePayerStatus();
  if (!status.enabled) {
    throw new InfraFeePayerError(
      'Dayfi XLM fee-paying account is disabled',
      'FEE_PAYER_DISABLED',
      503
    );
  }
  if (!status.publicKey) {
    throw new InfraFeePayerError(
      'Dayfi XLM fee-paying account is not configured',
      'FEE_PAYER_UNCONFIGURED',
      503
    );
  }
  if (!status.sufficient) {
    throw new InfraFeePayerError(
      `Insufficient Dayfi XLM network reserve (have ${status.availableXlm}, need ${status.minimumReserveXlm})`,
      'INSUFFICIENT_NETWORK_RESERVE',
      503
    );
  }
  return status;
}

/** Internal signing only — never call from HTTP handlers. */
export function getStellarFeePayerSigningSecret(): string {
  const secret = String(process.env.DAYFI_STELLAR_FEE_PAYER_SECRET || '').trim();
  if (!/^S[A-Z0-9]{55}$/.test(secret)) {
    throw new InfraFeePayerError(
      'DAYFI_STELLAR_FEE_PAYER_SECRET is not configured',
      'FEE_PAYER_SECRET_MISSING',
      503
    );
  }
  return secret;
}
