/**
 * Canonical phone-number normalization for Four.
 *
 * Four treats the E.164 phone number as a login key on a user identity, so two
 * spellings of the same number MUST collapse to one string. Divergence here is
 * an account-takeover / duplicate-identity bug, not a formatting nit.
 *
 * Nigeria-first: bare national numbers are interpreted as NG unless the caller
 * passes another default region. Anything already in `+<cc><nsn>` form is
 * validated and passed through.
 */

export type E164Ok = { ok: true; e164: string };
export type E164Err = { ok: false; reason: E164FailureReason };
export type E164Result = E164Ok | E164Err;

export type E164FailureReason =
  | 'empty'
  | 'contains_letters'
  | 'too_short'
  | 'too_long'
  | 'unsupported_region'
  | 'invalid_national_number';

/** Regions Four can normalize a bare national number for. */
export type SupportedRegion = 'NG';

const NG_COUNTRY_CODE = '234';

/** NG mobile national significant numbers are 10 digits starting 7, 8 or 9. */
const NG_NSN = /^[789]\d{9}$/;

/** E.164 allows at most 15 digits total, country code cannot start with 0. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Strip formatting humans type: spaces, dashes, dots, parens, non-breaking
 * spaces, and unicode dashes. Deliberately does NOT strip letters — a number
 * containing letters is rejected rather than silently mangled.
 */
function stripFormatting(raw: string): string {
  return raw.replace(/[\s\u00a0\u2000-\u200b().\-\u2010-\u2015_]/g, '');
}

/**
 * Normalize a phone number to E.164.
 *
 * Accepts, for NG: 08012345678, 8012345678, 2348012345678, +2348012345678,
 * 002348012345678, and any of those with spaces/dashes/parens.
 */
export function normalizePhoneE164(
  input: string | null | undefined,
  defaultRegion: SupportedRegion = 'NG'
): E164Result {
  if (input == null) return { ok: false, reason: 'empty' };

  let value = stripFormatting(String(input));
  if (value === '') return { ok: false, reason: 'empty' };

  if (/[a-zA-Z]/.test(value)) return { ok: false, reason: 'contains_letters' };

  // International prefix 00 is an alias for +.
  if (value.startsWith('00')) value = `+${value.slice(2)}`;

  if (value.startsWith('+')) {
    const digits = value.slice(1);
    if (!/^\d+$/.test(digits)) return { ok: false, reason: 'contains_letters' };
    if (digits.length < 8) return { ok: false, reason: 'too_short' };
    if (digits.length > 15) return { ok: false, reason: 'too_long' };
    if (!E164_PATTERN.test(value)) {
      return { ok: false, reason: 'invalid_national_number' };
    }
    return { ok: true, e164: value };
  }

  if (!/^\d+$/.test(value)) return { ok: false, reason: 'contains_letters' };

  if (defaultRegion !== 'NG') {
    return { ok: false, reason: 'unsupported_region' };
  }

  return normalizeNigerianNational(value);
}

function normalizeNigerianNational(digits: string): E164Result {
  let nsn: string;

  if (digits.startsWith(NG_COUNTRY_CODE)) {
    // 2348012345678
    nsn = digits.slice(NG_COUNTRY_CODE.length);
  } else if (digits.startsWith('0')) {
    // 08012345678 — national trunk prefix
    nsn = digits.slice(1);
  } else {
    // 8012345678 — bare NSN
    nsn = digits;
  }

  if (nsn.length < 10) return { ok: false, reason: 'too_short' };
  if (nsn.length > 10) return { ok: false, reason: 'too_long' };
  if (!NG_NSN.test(nsn)) return { ok: false, reason: 'invalid_national_number' };

  return { ok: true, e164: `+${NG_COUNTRY_CODE}${nsn}` };
}

/** Throwing variant for call sites that have already validated input. */
export function toPhoneE164OrThrow(
  input: string | null | undefined,
  defaultRegion: SupportedRegion = 'NG'
): string {
  const result = normalizePhoneE164(input, defaultRegion);
  if (!result.ok) {
    throw new Error(`Invalid phone number (${result.reason})`);
  }
  return result.e164;
}

/** Nullable variant for backfills and best-effort reads. */
export function toPhoneE164OrNull(
  input: string | null | undefined,
  defaultRegion: SupportedRegion = 'NG'
): string | null {
  const result = normalizePhoneE164(input, defaultRegion);
  return result.ok ? result.e164 : null;
}

/**
 * Mask a phone number for logs and user-facing copy: +2348012345678 → +234•••5678.
 * Never log a full phone number alongside an OTP.
 */
export function maskPhoneE164(e164: string): string {
  const value = String(e164 || '');
  if (value.length < 8) return '•••';
  return `${value.slice(0, 4)}•••${value.slice(-4)}`;
}
