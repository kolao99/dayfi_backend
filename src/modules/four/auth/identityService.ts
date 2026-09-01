import { db } from '../../../config/database';
import { FourError } from '../errors';

/**
 * Identity resolution for Four (rule D1).
 *
 * ONE consumer = ONE `users` row. Multiple authentication methods — email
 * /password, Google, Apple, phone OTP — all point at that single identity.
 * Phone OTP is an ADDITIONAL verified login method, never a parallel account.
 *
 * Consequences enforced here:
 *   - a phone that matches an existing user signs in to THAT user
 *   - signing in by phone never overwrites email, password, social links,
 *     wallet or transaction data
 *   - two distinct existing users are NEVER merged automatically (D1.5)
 */

export type FourUser = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  phone_e164: string | null;
  phone_verified: boolean;
  level: string;
  status: string;
  transaction_pin: string | null;
  created_at: Date;
  last_seen_at: Date | null;
};

const USER_COLUMNS = `user_id, email, first_name, last_name, phone_number,
                      phone_e164, phone_verified, level, status,
                      transaction_pin, created_at, last_seen_at`;

/**
 * Spellings of an E.164 number that may be sitting in the legacy, unnormalized
 * `users.phone_number` column.
 *
 * Exact digit forms only — never a suffix match, which would collide across
 * country codes and hand one user another's account.
 */
export function legacyPhoneCandidates(phoneE164: string): string[] {
  const digits = phoneE164.replace(/\D/g, '');
  const candidates = new Set<string>([digits]);

  // NG national forms: 2348012345678 → 8012345678 and 08012345678
  if (digits.startsWith('234') && digits.length === 13) {
    const nsn = digits.slice(3);
    candidates.add(nsn);
    candidates.add(`0${nsn}`);
  }

  return Array.from(candidates);
}

/**
 * Find the single existing user for this phone number, if there is one.
 * Throws `account_ambiguous` when more than one row matches: that is a data
 * condition requiring a deliberate, secure merge, not an automatic decision.
 */
export async function findUserByPhone(
  phoneE164: string
): Promise<FourUser | null> {
  const rows = await db.manyOrNone<FourUser>(
    `SELECT ${USER_COLUMNS}
       FROM users
      WHERE is_deleted IS NOT TRUE
        AND (
          phone_e164 = $1
          OR (
            phone_number IS NOT NULL
            AND regexp_replace(phone_number, '\\D', '', 'g') = ANY($2::text[])
          )
        )`,
    [phoneE164, legacyPhoneCandidates(phoneE164)]
  );

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.error(
      `[four/identity] ${rows.length} users match one phone number; refusing to merge. user_ids=${rows
        .map((r) => r.user_id)
        .join(',')}`
    );
    throw new FourError('account_ambiguous');
  }

  return rows[0];
}

function assertUsable(user: FourUser): void {
  if (user.status === 'deactivated' || user.status === 'blacklisted') {
    throw new FourError('account_inactive');
  }
}

/**
 * Resolve the identity behind a verified phone number, creating one only if the
 * number belongs to nobody.
 *
 * The update path is intentionally narrow: it touches phone verification
 * state, `last_seen_at`, and an activation/level-0 bump. It never writes
 * email, password, `refresh_token` (which carries the Google/Apple link) or
 * any financial column.
 */
export async function resolveOrCreateUserByPhone(
  phoneE164: string
): Promise<{ user: FourUser; isNewUser: boolean }> {
  const existing = await findUserByPhone(phoneE164);

  if (existing) {
    assertUsable(existing);
    const updated = await markPhoneVerified(existing.user_id, phoneE164);
    return { user: updated, isNewUser: false };
  }

  try {
    const created = await db.one<FourUser>(
      `INSERT INTO users
         (phone_number, phone_e164, phone_verified, phone_verified_at,
          status, level, last_seen_at)
       VALUES ($1, $1, true, NOW(), 'active', 'level-1', NOW())
       RETURNING ${USER_COLUMNS}`,
      [phoneE164]
    );
    return { user: created, isNewUser: true };
  } catch (err: any) {
    // Concurrent first sign-in for the same number: the loser re-reads.
    if (String(err?.code) === '23505') {
      const raced = await findUserByPhone(phoneE164);
      if (raced) {
        assertUsable(raced);
        return { user: raced, isNewUser: false };
      }
    }
    throw err;
  }
}

/**
 * Attach the verified phone to an existing identity.
 *
 * `level-0 → level-1` matches the existing consumer convention that level-1
 * means "phone verified" (authentication/controller.ts:219). A higher level is
 * never lowered.
 */
async function markPhoneVerified(
  userId: string,
  phoneE164: string
): Promise<FourUser> {
  try {
    return await db.one<FourUser>(
      `UPDATE users
          SET phone_e164 = $2,
              phone_number = COALESCE(phone_number, $2),
              phone_verified = true,
              phone_verified_at = COALESCE(phone_verified_at, NOW()),
              last_seen_at = NOW(),
              status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END,
              level = CASE WHEN level = 'level-0' THEN 'level-1' ELSE level END,
              updated_at = NOW()
        WHERE user_id = $1
        RETURNING ${USER_COLUMNS}`,
      [userId, phoneE164]
    );
  } catch (err: any) {
    // Another identity already claims this E.164 — a merge, which Four will
    // not perform automatically.
    if (String(err?.code) === '23505') {
      throw new FourError('account_ambiguous');
    }
    throw err;
  }
}

export async function getUserById(userId: string): Promise<FourUser | null> {
  return db.oneOrNone<FourUser>(
    `SELECT ${USER_COLUMNS}
       FROM users
      WHERE user_id = $1 AND is_deleted IS NOT TRUE`,
    [userId]
  );
}

export async function touchLastSeen(userId: string): Promise<void> {
  await db.none(`UPDATE users SET last_seen_at = NOW() WHERE user_id = $1`, [
    userId,
  ]);
}

export async function updateProfile(
  userId: string,
  patch: { firstName?: string; lastName?: string; email?: string }
): Promise<FourUser> {
  return db.one<FourUser>(
    `UPDATE users
        SET first_name = COALESCE($2, first_name),
            last_name  = COALESCE($3, last_name),
            email      = COALESCE($4, email),
            updated_at = NOW()
      WHERE user_id = $1
      RETURNING ${USER_COLUMNS}`,
    [
      userId,
      patch.firstName ?? null,
      patch.lastName ?? null,
      patch.email ? patch.email.toLowerCase() : null,
    ]
  );
}

/** Shape returned to the Four client. Never includes PIN or auth material. */
export function toPublicUser(user: FourUser) {
  return {
    id: user.user_id,
    phoneNumber: user.phone_e164 ?? user.phone_number,
    phoneVerified: Boolean(user.phone_verified),
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    kycLevel: user.level,
    hasTransactionPin: Boolean(user.transaction_pin),
    createdAt: user.created_at,
  };
}
