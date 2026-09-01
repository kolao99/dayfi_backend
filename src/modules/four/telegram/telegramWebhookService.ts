import {
  createConversation,
  getLatestConversation,
} from '../conversation/conversationService';
import { appendMessage } from '../conversation/messageService';
import {
  getLinkByTelegramUserId,
  updateTelegramChatId,
} from '../telegram/telegramLinkService';
import {
  answerCallbackQuery,
  sendTelegramMessage,
} from '../telegram/telegramClient';
import {
  handleUserText,
  replyMarkupForReview,
} from '../engine/conversationEngine';
import {
  getIntentForUser,
  updateIntent,
} from '../intent/intentService';

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export async function processTelegramUpdate(
  update: TelegramUpdate
): Promise<{ ok: boolean; reason?: string }> {
  if (update.callback_query) {
    return processCallbackQuery(update.callback_query);
  }

  const message = update.message;
  if (!message?.text || !message.from) {
    return { ok: true, reason: 'ignored_non_text' };
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  await updateTelegramChatId(telegramUserId, chatId).catch(() => undefined);

  const link = await getLinkByTelegramUserId(telegramUserId);
  if (!link) {
    await sendTelegramMessage({
      chatId,
      text:
        'Welcome to Four 👋\n\nLink your phone number first so I can access your Dayfi wallet.\n\nOpen the Mini App to verify with OTP.',
    });
    return { ok: true, reason: 'unlinked' };
  }

  let conversation = await getLatestConversation(link.user_id);
  if (!conversation) {
    conversation = await createConversation(link.user_id, 'Telegram');
  }

  await appendMessage({
    userId: link.user_id,
    conversationId: conversation.id,
    role: 'user',
    type: 'text',
    content: message.text,
  });

  const result = await handleUserText({
    userId: link.user_id,
    conversationId: conversation.id,
    text: message.text,
  });

  for (const reply of result.replies) {
    await sendTelegramMessage({
      chatId,
      text: reply.content,
      replyMarkup: replyMarkupForReview(reply, result.intentId),
    });
  }

  return { ok: true };
}

async function processCallbackQuery(
  query: TelegramCallbackQuery
): Promise<{ ok: boolean }> {
  const data = String(query.data ?? '');
  const chatId = query.message?.chat.id;
  const telegramUserId = query.from.id;

  await answerCallbackQuery(query.id);

  if (!chatId) return { ok: true };

  const link = await getLinkByTelegramUserId(telegramUserId);
  if (!link) return { ok: true };

  const parts = data.split(':');
  if (parts[0] !== 'four' || parts.length < 3) return { ok: true };

  const action = parts[1];
  const intentId = parts[2];

  if (action === 'confirm_send' && intentId) {
    const intent = await getIntentForUser(link.user_id, intentId);
    if (!intent || intent.status !== 'AWAITING_CONFIRMATION') {
      await sendTelegramMessage({
        chatId,
        text: 'That request has expired. Please start again.',
      });
      return { ok: true };
    }

    await updateIntent(link.user_id, intentId, {
      status: 'AWAITING_AUTHORIZATION',
    });

    await sendTelegramMessage({
      chatId,
      text: '🔐 Tap below to confirm with your PIN.',
      replyMarkup: replyMarkupForReview(
        {
          role: 'assistant',
          type: 'review',
          content: '',
          metadata: { buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: true }] },
        },
        intentId
      ),
    });
  }

  return { ok: true };
}
