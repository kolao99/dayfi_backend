import { db } from '../../../config/database';

/**
 * OTP policy: send rate limiting, attempt caps, expiry and single use.
 *
 * Twilio Verify holds the code. This table holds everything that stops the
 * endpoint being abused — without it, `request-otp` is an SMS-cost pump and
 * `verify-otp` is a 10,000-guess brute force against a 6-digit code.
 */

export type OtpPurpose = 'login' | 'add_phone' | 'recover';

/** How long a challenge stays usable. */
export const OTP_TTL_SECONDS = 10 * 60;
/** Wrong-code attempts allowed against one challenge. */
export const OTP_MAX_ATTEMPTS = 5;
/** Sliding window for the send-rate limit. */
export const OTP_SEND_WINDOW_SECONDS = 15 * 60;
/** Sends permitted to one number within the window. */
export const OTP_MAX_SENDS_PER_WINDOW = 3;
/** Minimum gap between two sends to the same number. */
export const OTP_MIN_RESEND_INTERVAL_SECONDS = 60;

export type OtpChallenge = {
  id: string;
  phone_e164: string;
  purpose: OtpPurpose;
  provider: string;
  provider_ref: string | null;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

export type SendAllowance =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Decide whether another code may be sent to this number.
 *
 * Two independent limits: a minimum gap between sends (stops rapid re-taps) and
 * a cap per sliding window (stops sustained pumping).
 */
export async function checkSendAllowance(
  phoneE164: string,
  purpose: OtpPurpose = 'login'
): Promise<SendAllowance> {
  const row = await db.one<{
    recent_sends: string;
    seconds_since_last: string | null;
  }>(
    `SELECT
       count(*) FILTER (
         WHERE created_at > NOW() - ($3 || ' seconds')::interval
       )::text AS recent_sends,
       EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::text AS seconds_since_last
     FROM four_otp_challenges
     WHERE phone_e164 = $1 AND purpose = $2`,
    [phoneE164, purpose, String(OTP_SEND_WINDOW_SECONDS)]
  );

  const secondsSinceLast =
    row.seconds_since_last == null ? null : Number(row.seconds_since_last);

  if (
    secondsSinceLast != null &&
    secondsSinceLast < OTP_MIN_RESEND_INTERVAL_SECONDS
  ) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(OTP_MIN_RESEND_INTERVAL_SECONDS - secondsSinceLast)
      ),
    };
  }

  if (Number(row.recent_sends) >= OTP_MAX_SENDS_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: OTP_SEND_WINDOW_SECONDS };
  }

  return { allowed: true };
}

/**
 * Start a new challenge, retiring any live one for the same number.
 *
 * Superseding matters: without it an attacker could keep an old challenge's
 * remaining attempts alive by requesting a fresh code.
 */
export async function createChallenge(input: {
  phoneE164: string;
  purpose?: OtpPurpose;
  provider: string;
  providerRef: string | null;
  ip?: string | null;
}): Promise<OtpChallenge> {
  const purpose = input.purpose ?? 'login';

  return db.tx(async (t) => {
    await t.none(
      `UPDATE four_otp_challenges
          SET consumed_at = NOW(), updated_at = NOW()
        WHERE phone_e164 = $1
          AND purpose = $2
          AND consumed_at IS NULL`,
      [input.phoneE164, purpose]
    );

    return t.one<OtpChallenge>(
      `INSERT INTO four_otp_challenges
         (phone_e164, purpose, provider, provider_ref, max_attempts, expires_at, ip)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::interval, $7)
       RETURNING id::text, phone_e164, purpose, provider, provider_ref,
                 attempts, max_attempts, expires_at, consumed_at, created_at`,
      [
        input.phoneE164,
        purpose,
        input.provider,
        input.providerRef,
        OTP_MAX_ATTEMPTS,
        String(OTP_TTL_SECONDS),
        input.ip ?? null,
      ]
    );
  });
}

/** The live, unconsumed, unexpired challenge for this number, if any. */
export async function findActiveChallenge(
  phoneE164: string,
  purpose: OtpPurpose = 'login'
): Promise<OtpChallenge | null> {
  return db.oneOrNone<OtpChallenge>(
    `SELECT id::text, phone_e164, purpose, provider, provider_ref,
            attempts, max_attempts, expires_at, consumed_at, created_at
       FROM four_otp_challenges
      WHERE phone_e164 = $1
        AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [phoneE164, purpose]
  );
}

/** Record a wrong code. Returns the challenge's state after incrementing. */
export async function recordFailedAttempt(
  challengeId: string
): Promise<{ attempts: number; exhausted: boolean }> {
  const row = await db.one<{ attempts: number; max_attempts: number }>(
    `UPDATE four_otp_challenges
        SET attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING attempts, max_attempts`,
    [challengeId]
  );
  const exhausted = row.attempts >= row.max_attempts;

  if (exhausted) {
    // Burn the challenge so further guesses need a fresh code (and therefore
    // pass back through the send-rate limit).
    await db.none(
      `UPDATE four_otp_challenges
          SET consumed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND consumed_at IS NULL`,
      [challengeId]
    );
  }

  return { attempts: row.attempts, exhausted };
}

/**
 * Consume a challenge. Returns false when it was already consumed, which makes
 * a verified code strictly single-use even under concurrent requests.
 */
export async function consumeChallenge(challengeId: string): Promise<boolean> {
  const row = await db.oneOrNone<{ id: string }>(
    `UPDATE four_otp_challenges
        SET consumed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING id::text`,
    [challengeId]
  );
  return row != null;
}
