import crypto from 'crypto';
import { db } from '../../../config/database';

/**
 * Server-side sessions for Four.
 *
 * The consumer app issues a stateless 30-day JWT that can only be revoked via a
 * blacklist. Four needs sessions it can expire, revoke and enumerate, so the
 * token here is an opaque random string; only its SHA-256 is stored. The raw
 * token is returned to the client exactly once.
 *
 * Deliberately does not use JWT: no signing secret to manage, and revocation is
 * a row update rather than a growing blacklist.
 */

const TOKEN_PREFIX = 'fs_';

function sessionTtlDays(): number {
  const raw = Number(process.env.FOUR_SESSION_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateSessionToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export type FourSession = {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type IssuedSession = FourSession & {
  /** Returned to the client once. Never persisted, never logged. */
  token: string;
};

export async function createSession(
  userId: string,
  context?: {
    deviceLabel?: string | null;
    platform?: string | null;
    ip?: string | null;
  }
): Promise<IssuedSession> {
  const token = generateSessionToken();

  const row = await db.one<{
    id: string;
    user_id: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `INSERT INTO four_sessions
       (user_id, token_hash, device_label, platform, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval)
     RETURNING id::text, user_id, expires_at, created_at`,
    [
      userId,
      hashSessionToken(token),
      context?.deviceLabel ?? null,
      context?.platform ?? null,
      context?.ip ?? null,
      String(sessionTtlDays()),
    ]
  );

  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    token,
  };
}

/**
 * Resolve a bearer token to a live session, touching `last_used_at`.
 * Returns null for unknown, revoked and expired tokens alike — the caller must
 * not be able to distinguish them.
 */
export async function validateSessionToken(
  token: string
): Promise<FourSession | null> {
  const raw = String(token || '').trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return null;

  const row = await db.oneOrNone<{
    id: string;
    user_id: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `UPDATE four_sessions
        SET last_used_at = NOW()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      RETURNING id::text, user_id, expires_at, created_at`,
    [hashSessionToken(raw)]
  );

  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Revoke by raw token (logout on the current device). */
export async function revokeSessionByToken(token: string): Promise<boolean> {
  const row = await db.oneOrNone<{ id: string }>(
    `UPDATE four_sessions
        SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id::text`,
    [hashSessionToken(String(token || '').trim())]
  );
  return row != null;
}

/** Revoke every live session for a user (sign out everywhere). */
export async function revokeAllSessionsForUser(
  userId: string
): Promise<number> {
  const rows = await db.manyOrNone<{ id: string }>(
    `UPDATE four_sessions
        SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id::text`,
    [userId]
  );
  return rows.length;
}

export async function listActiveSessions(
  userId: string
): Promise<Array<{ id: string; deviceLabel: string | null; platform: string | null; createdAt: Date; lastUsedAt: Date }>> {
  const rows = await db.manyOrNone<{
    id: string;
    device_label: string | null;
    platform: string | null;
    created_at: Date;
    last_used_at: Date;
  }>(
    `SELECT id::text, device_label, platform, created_at, last_used_at
       FROM four_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY last_used_at DESC`,
    [userId]
  );

  return rows.map((r) => ({
    id: r.id,
    deviceLabel: r.device_label,
    platform: r.platform,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}
