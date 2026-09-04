import { db } from '../../../config/database';
import {
  emptyConversationState,
  type AzapChannel,
  type AzapConversationState,
} from './stateTypes';

type StateRow = {
  user_id: string;
  channel: string;
  conversation_id: string;
  phone_e164: string | null;
  state: AzapConversationState;
  expires_at: Date | null;
  updated_at: Date;
};

function rowToState(row: StateRow): AzapConversationState {
  return {
    ...row.state,
    userId: row.user_id,
    channel: row.channel as AzapChannel,
    conversationId: row.conversation_id,
    phoneE164: row.phone_e164,
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

export async function getConversationState(
  conversationId: string
): Promise<AzapConversationState | null> {
  const row = await db.oneOrNone<StateRow>(
    `SELECT user_id, channel, conversation_id, phone_e164, state, expires_at, updated_at
       FROM azap_conversation_state
      WHERE conversation_id = $1`,
    [conversationId]
  );
  return row ? rowToState(row) : null;
}

export async function upsertConversationState(
  state: AzapConversationState
): Promise<AzapConversationState> {
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const row = await db.one<StateRow>(
    `INSERT INTO azap_conversation_state
       (user_id, channel, conversation_id, phone_e164, state, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
     ON CONFLICT (conversation_id)
     DO UPDATE SET
       phone_e164 = EXCLUDED.phone_e164,
       state = EXCLUDED.state,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()
     RETURNING user_id, channel, conversation_id, phone_e164, state, expires_at, updated_at`,
    [
      payload.userId,
      payload.channel,
      payload.conversationId,
      payload.phoneE164 ?? null,
      JSON.stringify(payload),
      payload.expiresAt ? new Date(payload.expiresAt) : null,
    ]
  );
  return rowToState(row);
}

export async function ensureConversationState(input: {
  userId: string;
  channel: AzapChannel;
  conversationId: string;
  phoneE164?: string | null;
}): Promise<AzapConversationState> {
  const existing = await getConversationState(input.conversationId);
  if (existing) return existing;
  return upsertConversationState(emptyConversationState(input));
}

export async function patchConversationState(
  conversationId: string,
  patch: Partial<AzapConversationState>
): Promise<AzapConversationState | null> {
  const current = await getConversationState(conversationId);
  if (!current) return null;
  return upsertConversationState({ ...current, ...patch });
}
