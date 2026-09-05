import {
  createConversation,
  getLatestConversation,
} from '../conversation/conversationService';
import { appendMessage } from '../conversation/messageService';
import { handleUserText, type EngineReply } from '../engine/conversationEngine';
import { getIntentForUser, updateIntent, getActiveIntentForConversation } from '../intent/intentService';
import { applyButtonSelection, buttonUserText } from './buttonState';
import {
  CAPABILITY_BUTTONS,
  capabilitiesIntro,
  createUserWallet,
  FUND_BUTTONS,
  airtimePrompt,
  billPaymentPrompt,
  genericNudge,
  getOnboardingStage,
  isGreeting,
  isMenuCommand,
  matchButtonByUserText,
  MENU_BUTTONS,
  ONBOARDING_BUTTONS,
  transferPrompt,
  returningGreeting,
  walletCreatingMessage,
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
import {
  buildReplyKeyboard,
  removeReplyKeyboard,
  replyMarkupForReview,
} from './telegramKeyboard';
import {
  getLinkMetadata,
  markIntroShown,
  resolveTelegramSession,
} from './telegramIdentityService';
import { handleAzapUtterance } from '../../azap/core/azapCore';
import { formatCapabilityMenu } from '../../azap/capabilities/registry';
import { beginCryptoFunding } from '../finance/cryptoDepositFlow';
import { beginNgnBankFunding } from '../finance/fiatFundingFlow';

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
  /** reply = WhatsApp-style keyboard (user message on tap); inline = persistent callbacks */
  keyboardMode?: 'reply' | 'inline';
};

function enrichEngineReplyForTelegram(
  reply: EngineReply,
  intentId?: string
): RoutedReply {
  const routed: RoutedReply = {
    ...reply,
    metadata: {
      ...reply.metadata,
      intentId: intentId ?? reply.metadata?.intentId,
    },
  };

  if (reply.metadata?.secureSurface === 'kyc') {
    routed.scope = 'kyc';
    routed.keyboardMode = 'inline';
    routed.webAppUrl = miniAppUrl({ mode: 'kyc' });
    routed.webAppLabel = 'Verify identity';
  }

  const metaButtons = reply.metadata?.buttons;
  if (Array.isArray(metaButtons) && metaButtons.length > 0) {
    routed.buttons = metaButtons as ChoiceButton[];
    routed.keyboardMode = routed.keyboardMode ?? 'reply';
  }
  if (typeof reply.metadata?.scope === 'string') {
    routed.scope = reply.metadata.scope;
  }

  return routed;
}

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
  replies: RoutedReply[],
  options?: { clearKeyboard?: boolean }
): Promise<void> {
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    const buttons = reply.buttons ?? [];
    const keyboardMode =
      reply.keyboardMode ??
      (reply.webAppUrl ? 'inline' : buttons.length ? 'reply' : 'none');

    let replyMarkup: Record<string, unknown> | undefined;
    if (options?.clearKeyboard && i === 0) {
      replyMarkup = removeReplyKeyboard();
    } else if (keyboardMode === 'reply' && buttons.length > 0) {
      replyMarkup = buildReplyKeyboard(buttons);
    } else if (
      keyboardMode === 'inline' &&
      (buttons.length > 0 || reply.webAppUrl)
    ) {
      replyMarkup = buildInlineKeyboard(buttons, {
        scope: reply.scope ?? 'action',
        intentId: reply.metadata?.intentId as string | undefined,
        webAppUrl: reply.webAppUrl,
        webAppLabel: reply.webAppLabel,
      });
    } else if (reply.type === 'review') {
      replyMarkup = replyMarkupForReview(
        reply,
        reply.metadata?.intentId as string | undefined
      );
    }

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

async function executeButtonAction(input: {
  chatId: number;
  userId: string;
  conversationId: string;
  telegramUserId: number;
  scope: string;
  button: ChoiceButton;
  firstName?: string;
}): Promise<void> {
  const { scope, button } = input;
  const action = button.id;

  if (scope === 'onboard' && action === 'create_wallet') {
    await deliverReplies(
      input.chatId,
      input.userId,
      input.conversationId,
      [
        {
          role: 'assistant',
          type: 'text',
          content: walletCreatingMessage(),
        },
      ],
      { clearKeyboard: true }
    );
    await createUserWallet(input.userId);
    await deliverReplies(
      input.chatId,
      input.userId,
      input.conversationId,
      [
        {
          role: 'assistant',
          type: 'choice',
          content: walletReadyMessage(),
          scope: 'onboard',
          keyboardMode: 'inline',
          webAppUrl: miniAppUrl({ mode: 'setup' }),
          webAppLabel: ONBOARDING_BUTTONS.setupPin.label,
        },
      ],
      { clearKeyboard: true }
    );
    return;
  }

  if (scope === 'capability') {
    await markIntroShown(input.telegramUserId);

    if (action === 'cap_balance') {
      const result = await handleUserText({
        userId: input.userId,
        conversationId: input.conversationId,
        text: "What's my balance?",
      });
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        result.replies,
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'cap_send') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: transferPrompt(),
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'cap_fund') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'choice',
            content: 'How would you like to fund your wallet?',
            buttons: FUND_BUTTONS.map((b) => ({ ...b })),
            scope: 'fund',
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'cap_airtime') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: airtimePrompt(),
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'cap_bills') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: billPaymentPrompt(),
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }
  }

  if (scope === 'menu') {
    if (action === 'menu_balance') {
      const result = await handleUserText({
        userId: input.userId,
        conversationId: input.conversationId,
        text: "What's my balance?",
      });
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        result.replies,
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'menu_send') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: transferPrompt(),
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'menu_fund') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'choice',
            content: 'How would you like to fund your wallet?',
            buttons: FUND_BUTTONS.map((b) => ({ ...b })),
            scope: 'fund',
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'menu_help') {
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: genericNudge(),
          },
        ],
        { clearKeyboard: true }
      );
      return;
    }
  }

  if (scope === 'fund') {
    if (action === 'fund_crypto') {
      const reply = await beginCryptoFunding({
        userId: input.userId,
        conversationId: input.conversationId,
      });
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [reply],
        { clearKeyboard: true }
      );
      return;
    }

    if (action === 'fund_bank_ngn') {
      const reply = await beginNgnBankFunding({
        userId: input.userId,
        conversationId: input.conversationId,
      });
      await deliverReplies(
        input.chatId,
        input.userId,
        input.conversationId,
        [enrichEngineReplyForTelegram(reply)],
        { clearKeyboard: true }
      );
    }
  }
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
  const linkMeta = await getLinkMetadata(input.telegramUserId);
  const stage = await getOnboardingStage(input.userId, {
    introShown: Boolean(linkMeta.introShown),
  });

  if (input.recordUserMessage !== false) {
    await appendMessage({
      userId: input.userId,
      conversationId: conversation.id,
      role: 'user',
      type: 'text',
      content: input.text,
      metadata: { source: 'user' },
    });
  }

  const buttonMatch = matchButtonByUserText(input.text);
  if (buttonMatch) {
    await executeButtonAction({
      chatId: input.chatId,
      userId: input.userId,
      conversationId: conversation.id,
      telegramUserId: input.telegramUserId,
      scope: buttonMatch.scope,
      button: buttonMatch.button,
      firstName: input.firstName,
    });
    return;
  }

  if (stage === 'ready') {
    if (isGreeting(input.text)) {
      const name = input.firstName || 'there';
      const active = await getActiveIntentForConversation(
        input.userId,
        conversation.id
      );
      const slots = (active?.slots as Record<string, unknown>) || {};
      let content = returningGreeting(name);
      if (
        active?.intent === 'FUND_CRYPTO' &&
        typeof slots.depositAddress === 'string' &&
        slots.depositAddress
      ) {
        const asset = String(slots.asset || 'USDC');
        content =
          `Hey ${name} 👋 I'm still here.\n\n` +
          `Your *${asset}* deposit address is ready whenever you need it:\n` +
          `\`${slots.depositAddress}\`\n\n` +
          `Ask "has it arrived?" after you send, or tell me what else you need.`;
      } else if (active) {
        content =
          `Hey ${name} 👋 I'm still here. We can continue where we left off, or start something new.`;
      }
      await deliverReplies(input.chatId, input.userId, conversation.id, [
        {
          role: 'assistant',
          type: 'text',
          content,
        },
      ]);
      return;
    }

    if (isMenuCommand(input.text) || input.text.trim().startsWith('/')) {
      const azap = await handleAzapUtterance({
        userId: input.userId,
        conversationId: conversation.id,
        text: input.text.trim() === 'menu' ? '/' : input.text,
      });
      if (azap.handled) {
        await deliverReplies(input.chatId, input.userId, conversation.id, [
          {
            role: 'assistant',
            type: 'text',
            content: azap.content || formatCapabilityMenu(),
          },
        ]);
        return;
      }
      if (azap.continueWithText) {
        const result = await handleUserText({
          userId: input.userId,
          conversationId: conversation.id,
          text: azap.continueWithText,
        });
        await deliverReplies(
          input.chatId,
          input.userId,
          conversation.id,
          result.replies.map((r) =>
            enrichEngineReplyForTelegram(r, result.intentId)
          )
        );
        return;
      }
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
      result.replies.map((r) =>
        enrichEngineReplyForTelegram(r, result.intentId)
      )
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
        keyboardMode: 'inline',
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
        { role: 'assistant', type: 'text', content: transferPrompt() },
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
        { role: 'assistant', type: 'text', content: airtimePrompt() },
      ]);
      return;
    }

    if (action === 'cap_bills') {
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        { role: 'assistant', type: 'text', content: billPaymentPrompt() },
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
        { role: 'assistant', type: 'text', content: transferPrompt() },
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
        { role: 'assistant', type: 'text', content: genericNudge() },
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
      const reply = await beginCryptoFunding({
        userId: session.user.user_id,
        conversationId: conversation.id,
      });
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        reply,
      ]);
      return;
    }

    if (action === 'fund_bank_ngn') {
      const reply = await beginNgnBankFunding({
        userId: session.user.user_id,
        conversationId: conversation.id,
      });
      await deliverReplies(chatId, session.user.user_id, conversation.id, [
        enrichEngineReplyForTelegram(reply),
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
      buttons: [
        { id: 'confirm_send', label: 'Confirm send', userText: 'Confirm send' },
      ],
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
          buttons: [
            { id: 'confirm_send', label: 'Confirm send', disabled: true },
          ],
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
          buttons: [
            { id: 'confirm_send', label: 'Confirm send', disabled: true },
          ],
        },
      },
    ]);
  }
}
