import { db } from '../../../config/database';

export type IntentName = 'BALANCE' | 'SEND_MONEY';

export type IntentStatus =
  | 'COLLECTING_INFORMATION'
  | 'AWAITING_CONFIRMATION'
  | 'AWAITING_AUTHORIZATION'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type FourActiveIntent = {
  id: string;
  conversation_id: string;
  user_id: string;
  intent: IntentName;
  status: IntentStatus;
  slots: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
};

const COLUMNS = `id::text, conversation_id::text, user_id, intent, status,
                 slots, metadata, created_at, updated_at, expires_at`;

const TERMINAL: IntentStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export async function getActiveIntentForConversation(
  userId: string,
  conversationId: string
): Promise<FourActiveIntent | null> {
  return db.oneOrNone<FourActiveIntent>(
    `SELECT ${COLUMNS}
       FROM four_active_intents
      WHERE conversation_id = $1 AND user_id = $2
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
        AND expires_at > NOW()`,
    [conversationId, userId]
  );
}

export async function getIntentForUser(
  userId: string,
  intentId: string
): Promise<FourActiveIntent | null> {
  return db.oneOrNone<FourActiveIntent>(
    `SELECT ${COLUMNS}
       FROM four_active_intents
      WHERE id = $1 AND user_id = $2`,
    [intentId, userId]
  );
}

export async function upsertActiveIntent(input: {
  userId: string;
  conversationId: string;
  intent: IntentName;
  status: IntentStatus;
  slots?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<FourActiveIntent> {
  return db.one<FourActiveIntent>(
    `INSERT INTO four_active_intents
       (conversation_id, user_id, intent, status, slots, metadata, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW() + INTERVAL '24 hours')
     ON CONFLICT (conversation_id)
     DO UPDATE SET
       intent = EXCLUDED.intent,
       status = EXCLUDED.status,
       slots = EXCLUDED.slots,
       metadata = EXCLUDED.metadata,
       updated_at = NOW(),
       expires_at = NOW() + INTERVAL '24 hours'
     RETURNING ${COLUMNS}`,
    [
      input.conversationId,
      input.userId,
      input.intent,
      input.status,
      JSON.stringify(input.slots ?? {}),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

export async function updateIntent(
  userId: string,
  intentId: string,
  patch: {
    status?: IntentStatus;
    slots?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<FourActiveIntent | null> {
  const existing = await getIntentForUser(userId, intentId);
  if (!existing) return null;

  const slots = patch.slots ?? existing.slots;
  const metadata = patch.metadata ?? existing.metadata;
  const status = patch.status ?? existing.status;

  return db.one<FourActiveIntent>(
    `UPDATE four_active_intents
        SET status = $3,
            slots = $4::jsonb,
            metadata = $5::jsonb,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING ${COLUMNS}`,
    [intentId, userId, status, JSON.stringify(slots), JSON.stringify(metadata)]
  );
}

export async function cancelActiveIntent(
  userId: string,
  conversationId: string
): Promise<void> {
  await db.none(
    `UPDATE four_active_intents
        SET status = 'CANCELLED', updated_at = NOW()
      WHERE conversation_id = $1 AND user_id = $2
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
    [conversationId, userId]
  );
}

export function isTerminalStatus(status: IntentStatus): boolean {
  return TERMINAL.includes(status);
}

export function toPublicIntent(intent: FourActiveIntent) {
  return {
    id: intent.id,
    conversationId: intent.conversation_id,
    intent: intent.intent,
    status: intent.status,
    slots: intent.slots ?? {},
    metadata: intent.metadata ?? {},
    createdAt: intent.created_at,
    updatedAt: intent.updated_at,
    expiresAt: intent.expires_at,
  };
}
