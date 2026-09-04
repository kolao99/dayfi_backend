import { db } from '../../../config/database';

export type FourWhatsappLink = {
  whatsapp_phone_e164: string;
  user_id: string;
  display_name: string | null;
  metadata: Record<string, unknown>;
  linked_at: Date;
};

const COLUMNS = `whatsapp_phone_e164, user_id, display_name, metadata, linked_at`;

export async function getLinkByWhatsappPhone(
  phoneE164: string
): Promise<FourWhatsappLink | null> {
  return db.oneOrNone<FourWhatsappLink>(
    `SELECT ${COLUMNS} FROM four_whatsapp_links WHERE whatsapp_phone_e164 = $1`,
    [phoneE164]
  );
}

export async function getLinkByUserId(
  userId: string
): Promise<FourWhatsappLink | null> {
  return db.oneOrNone<FourWhatsappLink>(
    `SELECT ${COLUMNS} FROM four_whatsapp_links WHERE user_id = $1`,
    [userId]
  );
}

export async function linkWhatsappUser(input: {
  userId: string;
  phoneE164: string;
  displayName?: string | null;
}): Promise<FourWhatsappLink> {
  return db.one<FourWhatsappLink>(
    `INSERT INTO four_whatsapp_links
       (whatsapp_phone_e164, user_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (whatsapp_phone_e164)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       display_name = COALESCE(EXCLUDED.display_name, four_whatsapp_links.display_name),
       linked_at = NOW(),
       updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [input.phoneE164, input.userId, input.displayName ?? null]
  );
}

export async function updateLinkMetadata(
  phoneE164: string,
  patch: Record<string, unknown>
): Promise<void> {
  await db.none(
    `UPDATE four_whatsapp_links
        SET metadata = metadata || $2::jsonb,
            updated_at = NOW()
      WHERE whatsapp_phone_e164 = $1`,
    [phoneE164, JSON.stringify(patch)]
  );
}

export async function getLinkMetadata(
  phoneE164: string
): Promise<Record<string, unknown>> {
  const row = await db.oneOrNone<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM four_whatsapp_links WHERE whatsapp_phone_e164 = $1`,
    [phoneE164]
  );
  return row?.metadata ?? {};
}
