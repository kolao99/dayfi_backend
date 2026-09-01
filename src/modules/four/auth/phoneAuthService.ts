import {
  maskPhoneE164,
  normalizePhoneE164,
} from '../../../shared/utils/phoneE164';
import { FourError } from '../errors';
import {
  checkSendAllowance,
  consumeChallenge,
  createChallenge,
  findActiveChallenge,
  recordFailedAttempt,
  OTP_TTL_SECONDS,
} from './otpChallengeStore';
import { getOtpProvider } from './otpProvider';
import {
  FourUser,
  resolveOrCreateUserByPhone,
  toPublicUser,
} from './identityService';
import { createSession, IssuedSession } from './sessionService';

/**
 * Phone + OTP authentication for Four. No password.
 *
 * Enumeration safety (rule D1.4): `requestOtp` never looks a user up. Whether
 * the number belongs to an existing account, a brand-new person, or nobody at
 * all, the response is identical. Identity is resolved only inside
 * `verifyOtp`, after the caller has proven they control the phone.
 */

export type RequestOtpResult = {
  sent: true;
  expiresInSeconds: number;
  /** Present so the client can render a resend countdown. */
  resendAfterSeconds: number;
};

export type VerifyOtpResult = {
  user: ReturnType<typeof toPublicUser>;
  session: IssuedSession;
  isNewUser: boolean;
  /** Client routing hints — the backend stays the source of truth. */
  needsProfile: boolean;
  needsPin: boolean;
};

function requireValidPhone(input: string): string {
  const result = normalizePhoneE164(input);
  if (!result.ok) throw new FourError('invalid_phone');
  return result.e164;
}

export async function requestOtp(input: {
  phone: string;
  ip?: string | null;
}): Promise<RequestOtpResult> {
  const phoneE164 = requireValidPhone(input.phone);

  const allowance = await checkSendAllowance(phoneE164, 'login');
  if (!allowance.allowed) {
    throw new FourError('otp_rate_limited', {
      retryAfterSeconds: allowance.retryAfterSeconds,
    });
  }

  const provider = getOtpProvider();

  let providerRef: string | null = null;
  try {
    const sendResult = await provider.send(phoneE164);
    providerRef = sendResult.providerRef;
  } catch (err) {
    console.error(
      `[four/auth] OTP send failed for ${maskPhoneE164(phoneE164)}`,
      err
    );
    throw new FourError('otp_send_failed', { cause: err });
  }

  await createChallenge({
    phoneE164,
    purpose: 'login',
    provider: provider.name,
    providerRef,
    ip: input.ip ?? null,
  });

  console.log(`[four/auth] OTP requested for ${maskPhoneE164(phoneE164)}`);

  // Identical shape for known and unknown numbers.
  return {
    sent: true,
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: 60,
  };
}

export async function verifyOtp(input: {
  phone: string;
  code: string;
  ip?: string | null;
  deviceLabel?: string | null;
  platform?: string | null;
}): Promise<VerifyOtpResult> {
  const phoneE164 = requireValidPhone(input.phone);
  const code = String(input.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) throw new FourError('otp_invalid');

  const challenge = await findActiveChallenge(phoneE164, 'login');
  // No live challenge: never distinguish "never requested" from "expired".
  if (!challenge) throw new FourError('otp_invalid');

  if (challenge.attempts >= challenge.max_attempts) {
    throw new FourError('otp_attempts_exceeded');
  }

  const provider = getOtpProvider();
  const approved = await provider.check(phoneE164, code);

  if (!approved) {
    const { exhausted } = await recordFailedAttempt(challenge.id);
    throw new FourError(exhausted ? 'otp_attempts_exceeded' : 'otp_invalid');
  }

  // Single use, even under concurrent verifies.
  const consumed = await consumeChallenge(challenge.id);
  if (!consumed) throw new FourError('otp_invalid');

  const { user, isNewUser } = await resolveOrCreateUserByPhone(phoneE164);

  const session = await createSession(user.user_id, {
    deviceLabel: input.deviceLabel ?? null,
    platform: input.platform ?? null,
    ip: input.ip ?? null,
  });

  console.log(
    `[four/auth] ${isNewUser ? 'created' : 'signed in'} user ${
      user.user_id
    } via ${maskPhoneE164(phoneE164)}`
  );

  return {
    user: toPublicUser(user),
    session,
    isNewUser,
    needsProfile: !hasName(user),
    needsPin: !user.transaction_pin,
  };
}

function hasName(user: FourUser): boolean {
  return Boolean(user.first_name && String(user.first_name).trim() !== '');
}
