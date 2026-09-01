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
import {
  applyButtonSelection,
  buttonUserText,
} from './buttonState';
import {
  CAPABILITY_BUTTONS,
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

export async function deliverReplies(
  chatId: number | string,
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

export async function sendCapabilitiesIntro(
  chatId: number | string,
  userId: string,
  telegramUserId: number | string
): Promise<void> {
  const conversation = await ensureConversation(userId);
  await deliverReplies(chatId, userId, conversation.id, [
    {
      role: 'assistant',
      type: 'choice',
      content: capabilitiesIntro(),
      buttons: CAPABILITY_BUTTONS.map((b) => ({ ...b })),
      scope: 'capability',
    },
  ]);
  await markIntroShown(telegramUserId);
}

async function recordUserSelection(input: {
  userId: string;
  conversationId: string;
  userText: string;
}): Promise<void> {
  await appendMessage({
    userId: input.userId,
    conversationId: input.conversationId,
    role: 'user',
    type: 'text',
    content: input.userText,
    metadata: { source: 'button' },
  });
}

async function processUserUtterance(input: {
  userId: string;
  telegramUserId: number;
  chatId: number;
  text: string;
  firstName?: string;
  recordUserMessage?: boolean;
}): Promise<void> {
  const conversation = await ensureConversation(input.userId);
  const stage = await getOnboardingStage(input.userId, input.telegramUserId);

  if (input.recordUserMessage !== false) {
    await appendMessage({
      userId: input.userId,
      conversationId: conversation.id,
      role: 'user',
      type: 'text',
      content: input.text,
    });
  }

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
    await deliverReplies(input.chatId, input.userId, conversation.id, [
      {
        role: 'assistant',
        type: 'choice',
        content: capabilitiesIntro(),
        buttons: CAPABILITY_BUTTONS.map((b) => ({ ...b })),
        scope: 'capability',
      },
    ]);
  }
}

export async function routeTelegramText(input: {
  userId: string;
  telegramUserId: number;
  chatId: number;
  text: string;
  firstName?: string;
}): Promise<void> {
  await processUserUtterance({ ...input, recordUserMessage: true });
}

async function markSelectedButtons(input: {
  chatId: number;
  messageId: number;
  scope: string;
  action: string;
  buttons: ChoiceButton[];
}): Promise<ChoiceButton[]> {
  const updated = applyButtonSelection(input.buttons, input.action);
  await editMessageReplyMarkup({
    chatId: input.chatId,
    messageId: input.messageId,
    replyMarkup: buildInlineKeyboard(updated, { scope: input.scope }),
  });
  return updated;
}

async function handleButtonSelection(input: {
  chatId: number;
  messageId: number;
  userId: string;
  conversationId: string;
  scope: string;
  action: string;
  buttons: ChoiceButton[];
}): Promise<ChoiceButton | null> {
  const button = input.buttons.find((b) => b.id === input.action);
  if (!button) return null;

  const userText = buttonUserText(button);
  await markSelectedButtons({
    chatId: input.chatId,
    messageId: input.messageId,
    scope: input.scope,
    action: input.action,
    buttons: input.buttons,
  });

  await recordUserSelection({
    userId: input.userId,
    conversationId: input.conversationId,
    userText,
  });

  return button;
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

  const session = await resolveTelegramSession({
    telegramUserId,
    chatId,
    firstName: query.from.first_name,
    username: query.from.username,
  });

  const conversation = await ensureConversation(session.user.user_id);
  const parts = data.split(':');

  if (parts[0] === 'four' && parts[1] === 'noop') return;

  const scope = parts[1] ?? '';
  const action = parts[2] ?? '';
  const extra = parts[3] ?? '';

  if (scope === 'onboard' && action === 'create_wallet') {
    await handleButtonSelection({
      chatId,
      messageId: telegramMessageId,
      userId: session.user.user_id,
      conversationId: conversation.id,
      scope,
      action,
      buttons: [{ ...ONBOARDING_BUTTONS.createWallet }],
    });
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

  if (scope === 'capability' && action.startsWith('cap_')) {
    const button = await handleButtonSelection({
      chatId,
      messageId: telegramMessageId,
      userId: session.user.user_id,
      conversationId: conversation.id,
      scope,
      action,
      buttons: CAPABILITY_BUTTONS.map((b) => ({ ...b })),
    });
    if (!button) return;

    await markIntroShown(telegramUserId);

    if (action === 'cap_balance') {
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

    if (action === 'cap_send') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            'Sure. Tell me who to send to and how much. Example: Send ₦20,000 to Kola.',
        },
      ]);
      return;
    }

    if (action === 'cap_fund') {
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

    if (action === 'cap_airtime') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            'Sure. Tell me the amount and phone number. Example: Top up my number with ₦500.',
        },
      ]);
      return;
    }

    if (action === 'cap_bills') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            'Sure. Tell me which bill to pay. Example: Pay my electricity bill.',
        },
      ]);
      return;
    }

    return;
  }

  if (scope === 'menu' && action.startsWith('menu_')) {
    const button = await handleButtonSelection({
      chatId,
      messageId: telegramMessageId,
      userId: session.user.user_id,
      conversationId: conversation.id,
      scope,
      action,
      buttons: MENU_BUTTONS.map((b) => ({ ...b })),
    });
    if (!button) return;

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
            'Sure. Tell me who to send to and how much. Example: Send ₦20,000 to Kola.',
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
            "Just tell me what you need in plain language. Try: What's my balance?, Send 20k to Kola, or /menu.",
        },
      ]);
    }
    return;
  }

  if (scope === 'fund') {
    const button = await handleButtonSelection({
      chatId,
      messageId: telegramMessageId,
      userId: session.user.user_id,
      conversationId: conversation.id,
      scope,
      action,
      buttons: FUND_BUTTONS.map((b) => ({ ...b })),
    });
    if (!button) return;

    if (action === 'fund_crypto') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content:
            "Sure. Tell me what asset you want to deposit and the network it's on. Example: USDC on Solana. Crypto deposits do not require BVN.",
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
            'To use bank transfer, please complete KYC with your BVN first. Send /kyc to get started.',
        },
      ]);
    }
    return;
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

    await markSelectedButtons({
      chatId,
      messageId: telegramMessageId,
      scope,
      action,
      buttons: [{ id: 'confirm_send', label: 'Confirm send', userText: 'Confirm send' }],
    });

    await recordUserSelection({
      userId: session.user.user_id,
      conversationId: conversation.id,
      userText: 'Confirm send',
    });

    await updateIntent(session.user.user_id, intentId, {
      status: 'AWAITING_AUTHORIZATION',
    });

    await deliverReplies(chatId, session.user.user_id, conversation.id, [
      {
        role: 'assistant',
        type: 'review',
        content: 'Tap below to confirm with your PIN. 🔐',
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
        content: 'Tap below to confirm with your PIN. 🔐',
        metadata: {
          intentId,
          buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: true }],
        },
      },
    ]);
  }
}
