/**
 * Decimal-safe USDC / XLM amounts (Stellar 7 decimal places).
 *
 * All fee math stays in integer minor units (bigint). Do not add
 * customer-facing money with IEEE floats.
 */

export const USDC_DECIMALS = 7;
export const XLM_DECIMALS = 7;
export const USDC_SCALE = BigInt(10000000);
export const XLM_SCALE = BigInt(10000000);

/** Stellar protocol BASE_FEE = 100 stroops = 0.0000100 XLM */
export const STELLAR_BASE_FEE_STROOPS = BigInt(100);

const ZERO = BigInt(0);

export class InfraMoneyError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraMoneyError';
    this.code = code;
    this.status = status;
  }
}

function parseDecimalToMinor(raw: unknown, scale: bigint, label: string): bigint {
  if (typeof raw === 'bigint') return raw;
  const text =
    typeof raw === 'number' && Number.isFinite(raw)
      ? raw.toFixed(7)
      : String(raw ?? '').trim();
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) {
    throw new InfraMoneyError(`Invalid ${label} amount`, 'INVALID_AMOUNT');
  }
  const neg = text.startsWith('-');
  const unsigned = neg ? text.slice(1) : text;
  const [wholeRaw, fracRaw = ''] = unsigned.split('.');
  if (fracRaw.length > 7) {
    throw new InfraMoneyError(
      `${label} supports at most 7 decimal places`,
      'INVALID_AMOUNT'
    );
  }
  const whole = BigInt(wholeRaw || '0');
  const fracPadded = (fracRaw + '0000000').slice(0, 7);
  const minor = whole * scale + BigInt(fracPadded);
  return neg ? -minor : minor;
}

export function parseUsdcToMinor(raw: unknown): bigint {
  return parseDecimalToMinor(raw, USDC_SCALE, 'USDC');
}

export function parseXlmToMinor(raw: unknown): bigint {
  return parseDecimalToMinor(raw, XLM_SCALE, 'XLM');
}

export function formatMinor(minor: bigint, scale: bigint): string {
  const neg = minor < ZERO;
  const abs = neg ? -minor : minor;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(7, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

export function formatUsdc(minor: bigint): string {
  return formatMinor(minor, USDC_SCALE);
}

export function formatXlm(minor: bigint): string {
  return formatMinor(minor, XLM_SCALE);
}

export function addMinor(a: bigint, b: bigint): bigint {
  return a + b;
}

export function assertPositiveMinor(minor: bigint, label: string): bigint {
  if (minor <= ZERO) {
    throw new InfraMoneyError(`${label} must be positive`, 'INVALID_AMOUNT');
  }
  return minor;
}

/** For existing ledger helpers that still accept number | string. */
export function usdcMinorToLedgerInput(minor: bigint): string {
  return formatUsdc(minor);
}

export function stellarBaseFeeXlm(): { minor: bigint; formatted: string } {
  return {
    minor: STELLAR_BASE_FEE_STROOPS,
    formatted: formatXlm(STELLAR_BASE_FEE_STROOPS),
  };
}
