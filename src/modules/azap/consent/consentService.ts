import crypto from 'crypto';
import { db } from '../../../config/database';

export type ConsentStatus =
  | 'presented'
  | 'accepted'
  | 'rejected'
  | 'expired';

export type ConsentRecord = {
  id: string;
  userId: string;
  consentType: string;
  version: string;
  status: ConsentStatus;
  channel: string | null;
  source: string | null;
  presentedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
};

export async function getLatestConsent(input: {
  userId: string;
  consentType: string;
  version: string;
}): Promise<ConsentRecord | null> {
  const row = await db.oneOrNone<{
    id: string;
    user_id: string;
    consent_type: string;
    version: string;
    status: ConsentStatus;
    channel: string | null;
    source: string | null;
    presented_at: Date | null;
    accepted_at: Date | null;
    rejected_at: Date | null;
  }>(
    `SELECT * FROM azap_consent_records
      WHERE user_id = $1 AND consent_type = $2 AND version = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.userId, input.consentType, input.version]
  );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type,
    version: row.version,
    status: row.status,
    channel: row.channel,
    source: row.source,
    presentedAt: row.presented_at?.toISOString() ?? null,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    rejectedAt: row.rejected_at?.toISOString() ?? null,
  };
}

export async function hasAcceptedConsent(input: {
  userId: string;
  consentType: string;
  version: string;
}): Promise<boolean> {
  const latest = await getLatestConsent(input);
  return latest?.status === 'accepted';
}

export async function presentConsent(input: {
  userId: string;
  consentType: string;
  version: string;
  channel?: string;
  source?: string;
}): Promise<ConsentRecord> {
  const id = `azap_cns_${crypto.randomBytes(8).toString('hex')}`;
  const row = await db.one<{
    id: string;
    user_id: string;
    consent_type: string;
    version: string;
    status: ConsentStatus;
    channel: string | null;
    source: string | null;
    presented_at: Date | null;
    accepted_at: Date | null;
    rejected_at: Date | null;
  }>(
    `INSERT INTO azap_consent_records
       (id, user_id, consent_type, version, status, channel, source, presented_at)
     VALUES ($1, $2, $3, $4, 'presented', $5, $6, NOW())
     RETURNING *`,
    [
      id,
      input.userId,
      input.consentType,
      input.version,
      input.channel ?? null,
      input.source ?? null,
    ]
  );
  return {
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type,
    version: row.version,
    status: row.status,
    channel: row.channel,
    source: row.source,
    presentedAt: row.presented_at?.toISOString() ?? null,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    rejectedAt: row.rejected_at?.toISOString() ?? null,
  };
}

export async function acceptConsent(input: {
  consentId: string;
  authorizationMethod: string;
}): Promise<void> {
  await db.none(
    `UPDATE azap_consent_records
        SET status = 'accepted',
            accepted_at = NOW(),
            authorization_method = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [input.consentId, input.authorizationMethod]
  );
}
