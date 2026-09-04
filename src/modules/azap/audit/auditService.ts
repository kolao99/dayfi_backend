import crypto from 'crypto';
import { db } from '../../../config/database';

/**
 * Append-only audit. Never log PIN, secrets, or raw tokens.
 */
export async function writeAzapAudit(input: {
  userId?: string | null;
  action: string;
  channel?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const safeMeta = { ...(input.metadata ?? {}) };
  for (const key of Object.keys(safeMeta)) {
    if (/pin|secret|token|password|private/i.test(key)) {
      delete safeMeta[key];
    }
  }

  const id = `azap_aud_${crypto.randomBytes(8).toString('hex')}`;
  await db.none(
    `INSERT INTO azap_audit_events
       (id, user_id, action, channel, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      id,
      input.userId ?? null,
      input.action,
      input.channel ?? null,
      input.resourceType ?? null,
      input.resourceId ?? null,
      JSON.stringify(safeMeta),
    ]
  );
}
