import {
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_TO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
} from '../../shared/lib/enums/lib.enums.status';

/**
 * Errors Four is willing to show a user.
 *
 * Every message here is deliberately safe to render in chat: no provider
 * strings, no internal identifiers, and nothing that reveals whether a phone
 * number belongs to an existing account (D1.4, no enumeration).
 */
export type FourErrorCode =
  | 'invalid_phone'
  | 'otp_rate_limited'
  | 'otp_invalid'
  | 'otp_expired'
  | 'otp_attempts_exceeded'
  | 'otp_send_failed'
  | 'session_invalid'
  | 'session_expired'
  | 'account_ambiguous'
  | 'account_inactive'
  | 'pin_invalid'
  | 'pin_not_set'
  | 'pin_already_set'
  | 'pin_mismatch'
  | 'intent_not_found'
  | 'intent_invalid_state'
  | 'telegram_auth_invalid'
  | 'telegram_not_linked'
  | 'transfer_failed';

const STATUS: Record<FourErrorCode, number> = {
  invalid_phone: HTTP_BAD_REQUEST,
  otp_rate_limited: HTTP_TO_MANY_REQUESTS,
  otp_invalid: HTTP_BAD_REQUEST,
  otp_expired: HTTP_BAD_REQUEST,
  otp_attempts_exceeded: HTTP_TO_MANY_REQUESTS,
  otp_send_failed: HTTP_BAD_REQUEST,
  session_invalid: HTTP_UNAUTHORIZED,
  session_expired: HTTP_UNAUTHORIZED,
  account_ambiguous: HTTP_CONFLICT,
  account_inactive: HTTP_FORBIDDEN,
  pin_invalid: HTTP_BAD_REQUEST,
  pin_not_set: HTTP_BAD_REQUEST,
  pin_already_set: HTTP_CONFLICT,
  pin_mismatch: HTTP_BAD_REQUEST,
  intent_not_found: HTTP_NOT_FOUND,
  intent_invalid_state: HTTP_BAD_REQUEST,
  telegram_auth_invalid: HTTP_UNAUTHORIZED,
  telegram_not_linked: HTTP_FORBIDDEN,
  transfer_failed: HTTP_BAD_REQUEST,
};

const MESSAGE: Record<FourErrorCode, string> = {
  invalid_phone: "That doesn't look like a valid phone number.",
  otp_rate_limited: 'Too many codes requested. Please wait a moment and try again.',
  // Same message for wrong and expired so a guesser learns nothing from it.
  otp_invalid: 'That code is incorrect or has expired.',
  otp_expired: 'That code is incorrect or has expired.',
  otp_attempts_exceeded: 'Too many incorrect attempts. Please request a new code.',
  otp_send_failed: "We couldn't send a code to that number. Please try again.",
  session_invalid: 'Please sign in again.',
  session_expired: 'Please sign in again.',
  account_ambiguous:
    'We need to verify this account manually. Please contact support.',
  account_inactive: 'This account is not active. Please contact support.',
  pin_invalid: 'That PIN is incorrect.',
  pin_not_set: 'Create a transaction PIN before sending money.',
  pin_already_set: 'Your transaction PIN is already set.',
  pin_mismatch: 'Those PINs do not match.',
  intent_not_found: 'That request was not found or has expired.',
  intent_invalid_state: 'That request is no longer ready to authorize.',
  telegram_auth_invalid: 'Telegram verification failed. Please open this from Azap in Telegram.',
  telegram_not_linked:
    'Link your phone number to Azap before authorizing payments.',
  transfer_failed:
    "We couldn't complete that transfer. Your money wasn't sent.",
};

export class FourError extends Error {
  public readonly code: FourErrorCode;
  public readonly httpStatus: number;
  /** Seconds the client should wait before retrying (rate limiting only). */
  public readonly retryAfterSeconds?: number;

  constructor(
    code: FourErrorCode,
    options?: { retryAfterSeconds?: number; cause?: unknown }
  ) {
    super(MESSAGE[code]);
    this.name = 'FourError';
    this.code = code;
    this.httpStatus = STATUS[code];
    this.retryAfterSeconds = options?.retryAfterSeconds;
    if (options?.cause) {
      // Kept for logs only; never serialized to the client.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isFourError(err: unknown): err is FourError {
  return err instanceof FourError;
}
