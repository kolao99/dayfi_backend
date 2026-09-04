import { db } from '../../../config/database';
import {
  getUserById,
  touchLastSeen,
  type FourUser,
} from '../auth/identityService';
import {
  getLinkByTelegramUserId,
  linkTelegramUser,
  type FourTelegramLink,
} from './telegramLinkService';

export type TelegramIdentityInput = {
  telegramUserId: number;
  chatId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
};

export type TelegramSession = {
  user: FourUser;
  link: FourTelegramLink;
  isNewUser: boolean;
};

/**
 * Telegram is the front door. First message auto-provisions a Dayfi user —
 * no OTP ceremony, no "link your phone" gate.
 */
export async function resolveTelegramSession(
  input: TelegramIdentityInput
): Promise<TelegramSession> {
  const existingLink = await getLinkByTelegramUserId(input.telegramUserId);
  if (existingLink) {
    const user = await getUserById(existingLink.user_id);
    if (!user) {
      throw new Error('Telegram link points to a missing user.');
    }
    await touchLastSeen(user.user_id);
    return { user, link: existingLink, isNewUser: false };
  }

  const firstName = String(input.firstName || 'Friend').trim() || 'Friend';
  const lastName = input.lastName?.trim() || null;

  const user = await db.one<FourUser>(
    `INSERT INTO users (first_name, last_name, status, level, last_seen_at)
     VALUES ($1, $2, 'active', 'level-0', NOW())
     RETURNING user_id, email, first_name, last_name, phone_number,
               phone_e164, phone_verified, level, status,
               transaction_pin, created_at, last_seen_at`,
    [firstName, lastName]
  );

  const link = await linkTelegramUser({
    userId: user.user_id,
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    username: input.username ?? null,
  });

  return { user, link, isNewUser: true };
}

export async function updateLinkMetadata(
  telegramUserId: number | string,
  patch: Record<string, unknown>
): Promise<void> {
  await db.none(
    `UPDATE four_telegram_links
        SET metadata = metadata || $2::jsonb,
            updated_at = NOW()
      WHERE telegram_user_id = $1`,
    [String(telegramUserId), JSON.stringify(patch)]
  );
}

export async function getLinkMetadata(
  telegramUserId: number | string
): Promise<Record<string, unknown>> {
  const row = await db.oneOrNone<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM four_telegram_links WHERE telegram_user_id = $1`,
    [String(telegramUserId)]
  );
  return row?.metadata ?? {};
}

export async function markIntroShown(
  telegramUserId: number | string
): Promise<void> {
  await updateLinkMetadata(telegramUserId, { introShown: true });
}
