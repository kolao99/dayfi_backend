import { db } from '../../../config/database';

/**
 * Message persistence and retrieval.
 *
 * Ordering is by `seq`, not `created_at`: two messages can share a timestamp,
 * and UUID primary keys do not sort by insertion order. `seq` gives a stable,
 * cursor-friendly total order.
 *
 * Date separators are NOT stored. They are derived from `created_at` at render
 * time, and a new calendar day never starts a new conversation (rule §13, §15).
 */

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'review'
  | 'payment'
  | 'receipt'
  | 'bill'
  | 'batch'
  | 'choice'
  | 'error'
  | 'event';

export const MESSAGE_ROLES: MessageRole[] = ['user', 'assistant', 'system'];

export const MESSAGE_TYPES: MessageType[] = [
  'text',
  'image',
  'voice',
  'review',
  'payment',
  'receipt',
  'bill',
  'batch',
  'choice',
  'error',
  'event',
];

export type FourMessage = {
  id: string;
  seq: string;
  conversation_id: string;
  user_id: string;
  role: MessageRole;
  type: MessageType;
  content: string | null;
  metadata: Record<string, unknown>;
  client_message_id: string | null;
  created_at: Date;
};

const COLUMNS = `id::text, seq::text, conversation_id::text, user_id, role, type,
                 content, metadata, client_message_id, created_at`;

/** Title derived from the first thing the user actually said. */
function deriveTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 57)}…`;
}

export type AppendMessageInput = {
  userId: string;
  conversationId: string;
  role: MessageRole;
  type?: MessageType;
  content?: string | null;
  metadata?: Record<string, unknown>;
  clientMessageId?: string | null;
};

export type AppendMessageResult = {
  message: FourMessage;
  /** True when an identical clientMessageId already existed (retry, not a new message). */
  deduplicated: boolean;
};

/**
 * Append a message to a conversation the user owns.
 *
 * Returns null when the conversation does not belong to the caller, so the
 * route can 404 without confirming the id exists.
 *
 * Resending the same `clientMessageId` returns the original message instead of
 * duplicating it, which makes an offline retry safe.
 */
export async function appendMessage(
  input: AppendMessageInput
): Promise<AppendMessageResult | null> {
  return db.tx(async (t) => {
    const conversation = await t.oneOrNone<{ id: string; title: string | null }>(
      `SELECT id::text, title FROM four_conversations
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [input.conversationId, input.userId]
    );
    if (!conversation) return null;

    const inserted = await t.oneOrNone<FourMessage>(
      `INSERT INTO four_messages
         (conversation_id, user_id, role, type, content, metadata, client_message_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (conversation_id, client_message_id)
         WHERE client_message_id IS NOT NULL
         DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.conversationId,
        input.userId,
        input.role,
        input.type ?? 'text',
        input.content ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.clientMessageId ?? null,
      ]
    );

    if (!inserted) {
      // Conflict: the client retried. Return what is already stored.
      const existing = await t.one<FourMessage>(
        `SELECT ${COLUMNS} FROM four_messages
          WHERE conversation_id = $1 AND client_message_id = $2`,
        [input.conversationId, input.clientMessageId]
      );
      return { message: existing, deduplicated: true };
    }

    const nextTitle =
      conversation.title == null && input.role === 'user' && input.content
        ? deriveTitle(input.content)
        : null;

    await t.none(
      `UPDATE four_conversations
          SET last_message_at = NOW(),
              updated_at = NOW(),
              title = COALESCE(title, $2)
        WHERE id = $1`,
      [input.conversationId, nextTitle]
    );

    return { message: inserted, deduplicated: false };
  });
}

export type ListMessagesResult = {
  messages: FourMessage[];
  /** Cursor for the next older page; null when the start has been reached. */
  nextBefore: string | null;
  hasMore: boolean;
};

/**
 * Newest-last page of a conversation, WhatsApp style: the app loads the most
 * recent messages, then pages backwards with `before`.
 *
 * Returns null when the conversation is not the caller's.
 */
export async function listMessages(
  userId: string,
  conversationId: string,
  options?: { limit?: number; before?: string | null }
): Promise<ListMessagesResult | null> {
  const owns = await db.oneOrNone<{ id: string }>(
    `SELECT id::text FROM four_conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  if (!owns) return null;

  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const before =
    options?.before != null && String(options.before).trim() !== ''
      ? String(options.before)
      : null;

  // limit + 1 detects another page without a second COUNT query.
  const rows = await db.manyOrNone<FourMessage>(
    `SELECT ${COLUMNS}
       FROM four_messages
      WHERE conversation_id = $1
        AND user_id = $2
        AND ($3::bigint IS NULL OR seq < $3::bigint)
      ORDER BY seq DESC
      LIMIT $4`,
    [conversationId, userId, before, limit + 1]
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    // Reverse to chronological order for rendering.
    messages: page.slice().reverse(),
    nextBefore: hasMore ? page[page.length - 1].seq : null,
    hasMore,
  };
}

export async function countMessages(
  userId: string,
  conversationId: string
): Promise<number> {
  const row = await db.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM four_messages
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return Number(row.n);
}

/** Shape returned to the Four client. */
export function toPublicMessage(message: FourMessage) {
  return {
    id: message.id,
    seq: message.seq,
    conversationId: message.conversation_id,
    role: message.role,
    type: message.type,
    content: message.content,
    metadata: message.metadata ?? {},
    clientMessageId: message.client_message_id,
    createdAt: message.created_at,
  };
}
