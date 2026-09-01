import { db } from '../../../config/database';

export type FourTelegramLink = {
  telegram_user_id: string;
  user_id: string;
  chat_id: string | null;
  telegram_username: string | null;
  linked_at: Date;
};

const COLUMNS = `telegram_user_id::text, user_id, chat_id::text,
                 telegram_username, linked_at`;

export async function getLinkByTelegramUserId(
  telegramUserId: number | string
): Promise<FourTelegramLink | null> {
  return db.oneOrNone<FourTelegramLink>(
    `SELECT ${COLUMNS} FROM four_telegram_links WHERE telegram_user_id = $1`,
    [String(telegramUserId)]
  );
}

export async function getLinkByUserId(
  userId: string
): Promise<FourTelegramLink | null> {
  return db.oneOrNone<FourTelegramLink>(
    `SELECT ${COLUMNS} FROM four_telegram_links WHERE user_id = $1`,
    [userId]
  );
}

export async function linkTelegramUser(input: {
  userId: string;
  telegramUserId: number | string;
  chatId?: number | string | null;
  username?: string | null;
}): Promise<FourTelegramLink> {
  return db.one<FourTelegramLink>(
    `INSERT INTO four_telegram_links
       (telegram_user_id, user_id, chat_id, telegram_username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       chat_id = COALESCE(EXCLUDED.chat_id, four_telegram_links.chat_id),
       telegram_username = COALESCE(EXCLUDED.telegram_username, four_telegram_links.telegram_username),
       linked_at = NOW(),
       updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [
      String(input.telegramUserId),
      input.userId,
      input.chatId != null ? String(input.chatId) : null,
      input.username ?? null,
    ]
  );
}

export async function updateTelegramChatId(
  telegramUserId: number | string,
  chatId: number | string
): Promise<void> {
  await db.none(
    `UPDATE four_telegram_links
        SET chat_id = $2, updated_at = NOW()
      WHERE telegram_user_id = $1`,
    [String(telegramUserId), String(chatId)]
  );
}
