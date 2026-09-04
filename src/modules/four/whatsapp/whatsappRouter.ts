import {
  createConversation,
  getLatestConversation,
} from '../conversation/conversationService';
import { appendMessage } from '../conversation/messageService';
import { handleUserText, type EngineReply } from '../engine/conversationEngine';
import {
  CAPABILITY_BUTTONS,
  capabilitiesIntro,
  createUserWallet,
  FUND_BUTTONS,
  genericNudge,
  getOnboardingStage,
  isGreeting,
  matchButtonById,
  matchButtonByUserText,
  ONBOARDING_BUTTONS,
  returningGreeting,
  transferPrompt,
  walletReadyMessage,
  welcomeMessage,
  type ChoiceButton,
} from '../telegram/onboardingService';
import { getLinkMetadata, updateLinkMetadata } from './whatsappLinkService';
import { whatsappSecureUrl } from './whatsappClient';
import { deliverWhatsappReplies, type RoutedReply } from './whatsappDelivery';
import {
  handleWhatsappPinSetupMessage,
  startWhatsappPinSetup,
} from './whatsappPinSetupFlow';
import { beginCryptoFunding } from '../finance/cryptoDepositFlow';
import { beginNgnBankFunding } from '../finance/fiatFundingFlow';
import { getActiveIntentForConversation } from '../intent/intentService';
import { handleAzapUtterance } from '../../azap/core/azapCore';
import { formatCapabilityMenu } from '../../azap/capabilities/registry';
import { getCryptoNetwork } from '../../../config/cryptoNetworks';

type RoutedReplyWithEngine = RoutedReply;

async function ensureConversation(userId: string) {
  let conversation = await getLatestConversation(userId);
  if (!conversation) {
    conversation = await createConversation(userId, 'WhatsApp');
  }
  return conversation;
}

function enrichEngineReplyForWhatsapp(
  reply: EngineReply,
  intentId?: string,
  userId?: string
): RoutedReplyWithEngine {
  const routed: RoutedReplyWithEngine = {
    ...reply,
    metadata: {
      ...reply.metadata,
      intentId: intentId ?? reply.metadata?.intentId,
    },
  };

  if (reply.metadata?.secureSurface === 'kyc' && userId) {
    routed.secureUrl = whatsappSecureUrl({ mode: 'kyc', userId });
    routed.secureLabel = 'Verify identity';
  }

  if (reply.type === 'review') {
    const resolvedIntentId = intentId ?? String(reply.metadata?.intentId ?? '');
    if (resolvedIntentId && userId) {
      routed.secureUrl = whatsappSecureUrl({
        mode: 'authorize',
        intent: resolvedIntentId,
        userId,
      });
      routed.secureLabel = 'Authorize with PIN';
    }
    routed.buttons = [
      {
        id: 'confirm_send',
        label: 'Confirm send',
        userText: 'Confirm send',
      },
      { id: 'cancel', label: 'Cancel', userText: 'Cancel' },
    ];
  } else {
    const metaButtons = reply.metadata?.buttons;
    if (Array.isArray(metaButtons) && metaButtons.length > 0) {
      routed.buttons = metaButtons as ChoiceButton[];
    }
    if (typeof reply.metadata?.scope === 'string') {
      routed.scope = reply.metadata.scope;
    }
  }

  return routed;
}

async function markWhatsappIntroShown(phoneE164: string): Promise<void> {
  await updateLinkMetadata(phoneE164, { introShown: true });
}

async function executeButtonAction(input: {
  phoneE164: string;
  userId: string;
  conversationId: string;
  scope: string;
  button: ChoiceButton;
  firstName?: string;
}): Promise<void> {
  const { scope, button } = input;
  const action = button.id;

  if (scope === 'onboard' && action === 'create_wallet') {
    await createUserWallet(input.userId);
    const setupUrl = whatsappSecureUrl({
      mode: 'setup',
      userId: input.userId,
    });
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      input.conversationId,
      [
        {
          role: 'assistant',
          type: 'choice',
          content: walletReadyMessage(),
          scope: 'onboard',
          secureUrl: setupUrl,
          secureLabel: ONBOARDING_BUTTONS.setupPin.label,
        },
      ]
    );
    return;
  }

  if (scope === 'onboard' && action === 'setup_pin') {
    await startWhatsappPinSetup({
      phoneE164: input.phoneE164,
      userId: input.userId,
      conversationId: input.conversationId,
    });
    return;
  }

  if (scope === 'capability') {
    await markWhatsappIntroShown(input.phoneE164);

    if (action === 'cap_balance') {
      const result = await handleUserText({
        userId: input.userId,
        conversationId: input.conversationId,
        text: "What's my balance?",
      });
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        result.replies.map((r) =>
          enrichEngineReplyForWhatsapp(r, result.intentId, input.userId)
        )
      );
      return;
    }

    if (action === 'cap_send') {
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: transferPrompt(),
          },
        ]
      );
      return;
    }

    if (action === 'cap_fund') {
      await deliverWhatsappReplies(
        input.phoneE164,
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
        ]
      );
      return;
    }

    if (action === 'cap_airtime') {
      const result = await handleUserText({
        userId: input.userId,
        conversationId: input.conversationId,
        text: 'Buy airtime',
      });
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        result.replies.map((r) =>
          enrichEngineReplyForWhatsapp(r, result.intentId, input.userId)
        )
      );
      return;
    }

    if (action === 'cap_bills') {
      const result = await handleUserText({
        userId: input.userId,
        conversationId: input.conversationId,
        text: 'Pay a bill',
      });
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        result.replies.map((r) =>
          enrichEngineReplyForWhatsapp(r, result.intentId, input.userId)
        )
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
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        result.replies.map((r) =>
          enrichEngineReplyForWhatsapp(r, result.intentId, input.userId)
        )
      );
      return;
    }

    if (action === 'menu_send') {
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: transferPrompt(),
          },
        ]
      );
      return;
    }

    if (action === 'menu_fund') {
      await deliverWhatsappReplies(
        input.phoneE164,
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
        ]
      );
      return;
    }

    if (action === 'menu_help') {
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        [
          {
            role: 'assistant',
            type: 'text',
            content: genericNudge(),
          },
        ]
      );
    }
  }

  if (scope === 'fund') {
    if (action === 'fund_crypto') {
      const reply = await beginCryptoFunding({
        userId: input.userId,
        conversationId: input.conversationId,
      });
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        [enrichEngineReplyForWhatsapp(reply, undefined, input.userId)]
      );
      return;
    }

    if (action === 'fund_bank_ngn') {
      const reply = await beginNgnBankFunding({
        userId: input.userId,
        conversationId: input.conversationId,
      });
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        input.conversationId,
        [enrichEngineReplyForWhatsapp(reply, undefined, input.userId)]
      );
      return;
    }
  }
}

export async function sendCapabilitiesIntro(
  phoneE164: string,
  userId: string
): Promise<void> {
  const conversation = await ensureConversation(userId);
  await deliverWhatsappReplies(phoneE164, userId, conversation.id, [
    {
      role: 'assistant',
      type: 'choice',
      content: capabilitiesIntro(),
      buttons: CAPABILITY_BUTTONS.map((b) => ({ ...b })),
      scope: 'capability',
    },
  ]);
  await markWhatsappIntroShown(phoneE164);
}

async function processUserUtterance(input: {
  userId: string;
  phoneE164: string;
  text: string;
  buttonPayload?: string;
  firstName?: string;
  inboundMessageId?: string;
}): Promise<void> {
  const conversation = await ensureConversation(input.userId);
  const linkMeta = await getLinkMetadata(input.phoneE164);
  const stage = await getOnboardingStage(input.userId, {
    introShown: Boolean(linkMeta.introShown),
  });

  const stored = await appendMessage({
    userId: input.userId,
    conversationId: conversation.id,
    role: 'user',
    type: input.buttonPayload ? 'event' : 'text',
    content: input.text,
    metadata: {
      source: 'user',
      channel: 'whatsapp',
      ...(input.buttonPayload
        ? { event: 'BUTTON_EVENT', buttonPayload: input.buttonPayload }
        : { event: 'USER_MESSAGE' }),
    },
    clientMessageId: input.inboundMessageId ?? null,
  });
  if (stored?.deduplicated) {
    return;
  }

  const pinHandled = await handleWhatsappPinSetupMessage({
    phoneE164: input.phoneE164,
    userId: input.userId,
    conversationId: conversation.id,
    text: input.text,
  });
  if (pinHandled) return;

  const buttonMatch =
    (input.buttonPayload ? matchButtonById(input.buttonPayload) : null) ??
    matchButtonByUserText(input.text);
  if (buttonMatch) {
    await executeButtonAction({
      phoneE164: input.phoneE164,
      userId: input.userId,
      conversationId: conversation.id,
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
        const networkKey = String(slots.network || 'stellar');
        const networkName =
          getCryptoNetwork(networkKey as any)?.name || networkKey;
        content =
          `Hey ${name} 👋 I'm still here.\n\n` +
          `Your *${asset}* ${networkName} deposit address is ready whenever you need it:\n` +
          `\`${slots.depositAddress}\`\n\n` +
          `Ask "has it arrived?" after you send, or tell me what else you need.`;
      } else if (active) {
        content =
          `Hey ${name} 👋 I'm still here. We can continue where we left off, or start something new.`;
      }
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        conversation.id,
        [
          {
            role: 'assistant',
            type: 'text',
            content,
          },
        ]
      );
      return;
    }

    const azap = await handleAzapUtterance({
      userId: input.userId,
      conversationId: conversation.id,
      text: input.text.trim() === 'menu' ? '/' : input.text,
    });
    if (azap.handled) {
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        conversation.id,
        [
          {
            role: 'assistant',
            type: 'text',
            content: azap.content || formatCapabilityMenu(),
          },
        ]
      );
      return;
    }
    if (azap.continueWithText) {
      const result = await handleUserText({
        userId: input.userId,
        conversationId: conversation.id,
        text: azap.continueWithText,
      });
      await deliverWhatsappReplies(
        input.phoneE164,
        input.userId,
        conversation.id,
        result.replies.map((r) =>
          enrichEngineReplyForWhatsapp(r, result.intentId, input.userId)
        )
      );
      return;
    }

    const result = await handleUserText({
      userId: input.userId,
      conversationId: conversation.id,
      text: input.text,
    });

    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      conversation.id,
      result.replies.map((r) =>
        enrichEngineReplyForWhatsapp(r, result.intentId, input.userId)
      )
    );
    return;
  }

  if (stage === 'welcome') {
    const name = input.firstName || 'Friend';
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      conversation.id,
      [
        {
          role: 'assistant',
          type: 'choice',
          content: welcomeMessage(name, 'whatsapp'),
          buttons: [{ ...ONBOARDING_BUTTONS.createWallet }],
          scope: 'onboard',
        },
      ]
    );
    return;
  }

  if (stage === 'pin_required') {
    await startWhatsappPinSetup({
      phoneE164: input.phoneE164,
      userId: input.userId,
      conversationId: conversation.id,
    });
    return;
  }

  if (stage === 'intro_pending') {
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      conversation.id,
      [
        {
          role: 'assistant',
          type: 'choice',
          content: capabilitiesIntro(),
          buttons: CAPABILITY_BUTTONS.map((b) => ({ ...b })),
          scope: 'capability',
        },
      ]
    );
  }
}

export async function routeWhatsappText(input: {
  userId: string;
  phoneE164: string;
  text: string;
  buttonPayload?: string;
  firstName?: string;
  inboundMessageId?: string;
}): Promise<void> {
  await processUserUtterance(input);
}
