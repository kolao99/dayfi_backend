import { db } from '../../../config/database';

/**
 * Conversations are backend-owned (rule §13, §16).
 *
 * Every query in this file is scoped by `user_id` in the WHERE clause rather
 * than filtered after the fact, so there is no code path that can return one
 * user's conversation to another (rule §60).
 */

export type FourConversation = {
  id: string;
  user_id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date;
  archived_at: Date | null;
};

const COLUMNS = `id::text, user_id, title, created_at, updated_at,
                 last_message_at, archived_at`;

export async function createConversation(
  userId: string,
  title?: string | null
): Promise<FourConversation> {
  return db.one<FourConversation>(
    `INSERT INTO four_conversations (user_id, title)
     VALUES ($1, $2)
     RETURNING ${COLUMNS}`,
    [userId, title ?? null]
  );
}

/**
 * The conversation to reopen on launch. Returns null for a brand-new user —
 * this is a pure read, so the client creates the first conversation explicitly
 * rather than a GET having a side effect.
 */
export async function getLatestConversation(
  userId: string
): Promise<FourConversation | null> {
  return db.oneOrNone<FourConversation>(
    `SELECT ${COLUMNS}
       FROM four_conversations
      WHERE user_id = $1 AND archived_at IS NULL
      ORDER BY last_message_at DESC
      LIMIT 1`,
    [userId]
  );
}

/**
 * Ownership-checked fetch. Returns null when the conversation belongs to
 * someone else, which the caller surfaces as 404 — never 403, which would
 * confirm the id exists.
 */
export async function getConversationForUser(
  userId: string,
  conversationId: string
): Promise<FourConversation | null> {
  return db.oneOrNone<FourConversation>(
    `SELECT ${COLUMNS}
       FROM four_conversations
      WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
}

export async function listConversations(
  userId: string,
  options?: { limit?: number; includeArchived?: boolean }
): Promise<FourConversation[]> {
  const limit = Math.min(Math.max(options?.limit ?? 30, 1), 100);
  return db.manyOrNone<FourConversation>(
    `SELECT ${COLUMNS}
       FROM four_conversations
      WHERE user_id = $1
        AND ($3 OR archived_at IS NULL)
      ORDER BY last_message_at DESC
      LIMIT $2`,
    [userId, limit, options?.includeArchived === true]
  );
}

/**
 * Starting a new chat must never delete the previous one (rule §17).
 * Archiving is available but the "new chat" action does not use it.
 */
export async function archiveConversation(
  userId: string,
  conversationId: string
): Promise<boolean> {
  const row = await db.oneOrNone<{ id: string }>(
    `UPDATE four_conversations
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
      RETURNING id::text`,
    [conversationId, userId]
  );
  return row != null;
}

export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string
): Promise<FourConversation | null> {
  return db.oneOrNone<FourConversation>(
    `UPDATE four_conversations
        SET title = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING ${COLUMNS}`,
    [conversationId, userId, title]
  );
}

/** Shape returned to the Four client. */
export function toPublicConversation(conversation: FourConversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    lastMessageAt: conversation.last_message_at,
    archived: conversation.archived_at != null,
  };
}
