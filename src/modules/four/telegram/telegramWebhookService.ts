import { updateTelegramChatId } from './telegramLinkService';
import {
  routeTelegramCallback,
  routeTelegramText,
  type TelegramUpdate,
} from './telegramRouter';
import { resolveTelegramSession } from './telegramIdentityService';

export type { TelegramUpdate };

export async function processTelegramUpdate(
  update: TelegramUpdate
): Promise<{ ok: boolean; reason?: string }> {
  if (update.callback_query) {
    await routeTelegramCallback(update.callback_query);
    return { ok: true };
  }

  const message = update.message;
  if (!message?.text || !message.from) {
    return { ok: true, reason: 'ignored_non_text' };
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;

  const session = await resolveTelegramSession({
    telegramUserId,
    chatId,
    firstName: message.from.first_name,
    lastName: message.from.last_name,
    username: message.from.username,
  });

  await updateTelegramChatId(telegramUserId, chatId).catch(() => undefined);

  await routeTelegramText({
    userId: session.user.user_id,
    telegramUserId,
    chatId,
    text: message.text,
    firstName: message.from.first_name,
  });

  return { ok: true, reason: session.isNewUser ? 'new_user' : 'message' };
}
