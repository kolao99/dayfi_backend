import {
  createConversation,
  getLatestConversation,
} from '../conversation/conversationService';
import { appendMessage } from '../conversation/messageService';
import {
  handleUserText,
  replyMarkupForReview,
  type EngineReply,
} from '../engine/conversationEngine';
import { getIntentForUser, updateIntent } from '../intent/intentService';
import { applyButtonSelection } from './buttonState';
import {
  capabilitiesIntro,
  createUserWallet,
  FUND_BUTTONS,
  getOnboardingStage,
  isGreeting,
  isMenuCommand,
  markIntroShown,
  MENU_BUTTONS,
  menuMessage,
  ONBOARDING_BUTTONS,
  returningGreeting,
  walletReadyMessage,
  welcomeMessage,
  type ChoiceButton,
} from './onboardingService';
import {
  answerCallbackQuery,
  buildInlineKeyboard,
  editMessageReplyMarkup,
  miniAppUrl,
  sendTelegramMessage,
} from './telegramClient';
import { resolveTelegramSession } from './telegramIdentityService';

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
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

type RoutedReply = EngineReply & {
  buttons?: ChoiceButton[];
  scope?: string;
  webAppUrl?: string | null;
  webAppLabel?: string;
};

async function ensureConversation(userId: string) {
  let conversation = await getLatestConversation(userId);
  if (!conversation) {
    conversation = await createConversation(userId, 'Telegram');
  }
  return conversation;
}

async function deliverReplies(
  chatId: number,
  userId: string,
  conversationId: string,
  replies: RoutedReply[]
): Promise<void> {
  for (const reply of replies) {
    const buttons = reply.buttons ?? [];
    const replyMarkup =
      buttons.length > 0 || reply.webAppUrl
        ? buildInlineKeyboard(buttons, {
            scope: reply.scope ?? 'action',
            intentId: reply.metadata?.intentId as string | undefined,
            webAppUrl: reply.webAppUrl,
            webAppLabel: reply.webAppLabel,
          })
        : replyMarkupForReview(
            reply,
            reply.metadata?.intentId as string | undefined
          );

    const sent = await sendTelegramMessage({
      chatId,
      text: reply.content,
      replyMarkup,
    });

    await appendMessage({
      userId,
      conversationId,
      role: 'assistant',
      type: reply.type,
      content: reply.content,
      metadata: {
        ...(reply.metadata ?? {}),
        buttons,
        scope: reply.scope,
        telegramMessageId: sent.messageId,
      },
    });
  }
}

export async function routeTelegramText(input: {
  userId: string;
  telegramUserId: number;
  chatId: number;
  text: string;
  firstName?: string;
}): Promise<void> {
  const conversation = await ensureConversation(input.userId);
  const stage = await getOnboardingStage(input.userId, input.telegramUserId);

  await appendMessage({
    userId: input.userId,
    conversationId: conversation.id,
    role: 'user',
    type: 'text',
    content: input.text,
  });

  if (stage === 'ready') {
    if (isGreeting(input.text)) {
      const name = input.firstName || 'there';
      await deliverReplies(input.chatId, input.userId, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content: returningGreeting(name),
        },
      ]);
      return;
    }

    if (isMenuCommand(input.text)) {
      await deliverReplies(input.chatId, input.userId, conversation.id, [
        {
          role: 'assistant',
          type: 'choice',
          content: menuMessage(),
          buttons: MENU_BUTTONS.map((b) => ({ ...b })),
          scope: 'menu',
        },
      ]);
      return;
    }

    const result = await handleUserText({
      userId: input.userId,
      conversationId: conversation.id,
      text: input.text,
    });

    await deliverReplies(
      input.chatId,
      input.userId,
      conversation.id,
      result.replies.map((r) => ({
        ...r,
        metadata: { ...r.metadata, intentId: result.intentId },
      }))
    );
    return;
  }

  if (stage === 'welcome') {
    const name = input.firstName || 'Friend';
    await deliverReplies(input.chatId, input.userId, conversation.id, [
      {
        role: 'assistant',
        type: 'choice',
        content: welcomeMessage(name),
        buttons: [{ ...ONBOARDING_BUTTONS.createWallet }],
        scope: 'onboard',
      },
    ]);
    return;
  }

  if (stage === 'pin_required') {
    await deliverReplies(input.chatId, input.userId, conversation.id, [
      {
        role: 'assistant',
        type: 'choice',
        content: walletReadyMessage(),
        scope: 'onboard',
        webAppUrl: miniAppUrl({ mode: 'setup' }),
        webAppLabel: ONBOARDING_BUTTONS.setupPin.label,
      },
    ]);
    return;
  }

  if (stage === 'intro_pending') {
    await markIntroShown(input.telegramUserId);
    await deliverReplies(input.chatId, input.userId, conversation.id, [
      {
        role: 'assistant',
        type: 'text',
        content: capabilitiesIntro(),
      },
    ]);
  }
}

export async function routeTelegramCallback(
  query: TelegramCallbackQuery
): Promise<void> {
  const data = String(query.data ?? '');
  const chatId = query.message?.chat.id;
  const telegramUserId = query.from.id;
  const telegramMessageId = query.message?.message_id;

  await answerCallbackQuery(query.id);

  if (chatId == null || telegramMessageId == null) return;

  const activeChatId = chatId;
  const activeMessageId = telegramMessageId;

  const session = await resolveTelegramSession({
    telegramUserId,
    chatId: activeChatId,
    firstName: query.from.first_name,
    username: query.from.username,
  });

  const conversation = await ensureConversation(session.user.user_id);
  const parts = data.split(':');

  if (parts[0] === 'four' && parts[1] === 'noop') return;

  const scope = parts[1] ?? '';
  const action = parts[2] ?? '';
  const extra = parts[3] ?? '';

  async function markSelected(buttons: ChoiceButton[]): Promise<void> {
    const updated = applyButtonSelection(buttons, action);
    await editMessageReplyMarkup({
      chatId: activeChatId,
      messageId: activeMessageId,
      replyMarkup: buildInlineKeyboard(updated, { scope }),
    });
  }

  if (scope === 'onboard' && action === 'create_wallet') {
    await markSelected([{ ...ONBOARDING_BUTTONS.createWallet }]);
    await createUserWallet(session.user.user_id);
    await deliverReplies(chatId, session.user.user_id, conversation.id, [
      {
        role: 'assistant',
        type: 'choice',
        content: walletReadyMessage(),
        scope: 'onboard',
        webAppUrl: miniAppUrl({ mode: 'setup' }),
        webAppLabel: ONBOARDING_BUTTONS.setupPin.label,
      },
    ]);
    return;
  }

  if (scope === 'menu' && action.startsWith('menu_')) {
    await markSelected(MENU_BUTTONS.map((b) => ({ ...b })));

    if (action === 'menu_balance') {
      const result = await handleUserText({
        userId: session.user.user_id,
        conversationId: conversation.id,
        text: "What's my balance?",
      });
      await deliverReplies(
        chatId,
        session.user.user_id,
        conversation.id,
        result.replies
      );
      return;
    }

    if (action === 'menu_send') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            'Sure. Tell me who to send to and how much.\n\nExample: Send ₦20,000 to Kola',
        },
      ]);
      return;
    }

    if (action === 'menu_fund') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'choice',
          content: 'How would you like to fund your wallet?',
          buttons: FUND_BUTTONS.map((b) => ({ ...b })),
          scope: 'fund',
        },
      ]);
      return;
    }

    if (action === 'menu_help') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            "Just tell me what you need in plain language.\n\nTry:\n• What's my balance?\n• Send 20k to Kola\n• /menu",
        },
      ]);
      return;
    }
  }

  if (scope === 'fund') {
    await markSelected(FUND_BUTTONS.map((b) => ({ ...b })));

    if (action === 'fund_crypto') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            "Sure. Tell me what asset you want to deposit and the network it's on.\n\nExample: **USDC on Solana**\n\nCrypto deposits do not require BVN.",
        },
      ]);
      return;
    }

    if (action === 'fund_bank_ngn') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            'To use bank transfer, please complete KYC with your BVN first.\n\nSend /kyc to get started.',
        },
      ]);
      return;
    }
  }

  if (scope === 'send' && action === 'confirm_send' && extra) {
    const intentId = extra;
    const intent = await getIntentForUser(session.user.user_id, intentId);
    if (!intent || intent.status !== 'AWAITING_CONFIRMATION') {
      await sendTelegramMessage({
        chatId,
        text: 'That request has expired. Please start again.',
      });
      return;
    }

    await markSelected([
      { id: 'confirm_send', label: 'Confirm send', disabled: false },
    ]);

    await updateIntent(session.user.user_id, intentId, {
      status: 'AWAITING_AUTHORIZATION',
    });

    await deliverReplies(chatId, session.user.user_id, conversation.id, [
      {
        role: 'assistant',
        type: 'review',
        content: '🔐 Tap below to confirm with your PIN.',
        metadata: {
          intentId,
          buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: true }],
        },
      },
    ]);
    return;
  }

  if (scope === 'confirm_send' && action) {
    const intentId = action;
    const intent = await getIntentForUser(session.user.user_id, intentId);
    if (!intent || intent.status !== 'AWAITING_CONFIRMATION') {
      await sendTelegramMessage({
        chatId,
        text: 'That request has expired. Please start again.',
      });
      return;
    }

    await updateIntent(session.user.user_id, intentId, {
      status: 'AWAITING_AUTHORIZATION',
    });

    await deliverReplies(chatId, session.user.user_id, conversation.id, [
      {
        role: 'assistant',
        type: 'review',
        content: '🔐 Tap below to confirm with your PIN.',
        metadata: {
          intentId,
          buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: true }],
        },
      },
    ]);
  }
}
