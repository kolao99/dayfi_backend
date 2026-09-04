import { setupTransactionPin } from '../security/pinSetupService';
import { FourError } from '../errors';
import {
  CAPABILITY_BUTTONS,
  capabilitiesIntro,
  ONBOARDING_BUTTONS,
  pinSecuredMessage,
  walletReadyMessage,
} from '../telegram/onboardingService';
import { whatsappSecureUrl } from './whatsappClient';
import { deliverWhatsappReplies } from './whatsappDelivery';
import {
  getLinkMetadata,
  updateLinkMetadata,
} from './whatsappLinkService';
import {
  isWhatsappPinFlowConfigured,
  sendWhatsappPinSetupFlow,
} from './flows/sendPinSetupFlow';
import { appendMessage } from '../conversation/messageService';

export type PinSetupStep = 'enter' | 'confirm';

type PinSetupMeta = {
  pinSetupStep?: PinSetupStep;
  pinSetupDraft?: string;
};

function readPinSetup(meta: Record<string, unknown>): PinSetupMeta {
  const step = meta.pinSetupStep;
  const draft = meta.pinSetupDraft;
  return {
    pinSetupStep:
      step === 'enter' || step === 'confirm' ? step : undefined,
    pinSetupDraft: typeof draft === 'string' ? draft : undefined,
  };
}

export async function isPinSetupActive(phoneE164: string): Promise<boolean> {
  const meta = await getLinkMetadata(phoneE164);
  return readPinSetup(meta).pinSetupStep != null;
}

/**
 * Prefer WhatsApp Flow (native bottom sheet). Falls back to Safari CTA URL
 * only when META_WHATSAPP_PIN_FLOW_ID / _NAME is not configured.
 */
export async function startWhatsappPinSetup(input: {
  phoneE164: string;
  userId: string;
  conversationId: string;
}): Promise<void> {
  await updateLinkMetadata(input.phoneE164, {
    pinSetupStep: null,
    pinSetupDraft: null,
  });

  const body = walletReadyMessage();

  if (isWhatsappPinFlowConfigured()) {
    try {
      const sent = await sendWhatsappPinSetupFlow({
        toPhoneE164: input.phoneE164,
        userId: input.userId,
        bodyText: body,
        ctaLabel: ONBOARDING_BUTTONS.setupPin.label,
      });
      await appendMessage({
        userId: input.userId,
        conversationId: input.conversationId,
        role: 'assistant',
        type: 'choice',
        content: body,
        metadata: {
          channel: 'whatsapp',
          pinFlow: true,
          whatsappMessageSid: sent.messageId,
          scope: 'onboard',
        },
      });
      return;
    } catch (err) {
      console.error(
        '[azap/flow] PIN Flow send failed; falling back to CTA URL',
        err
      );
    }
  }

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
        content: body,
        scope: 'onboard',
        secureUrl: setupUrl,
        secureLabel: ONBOARDING_BUTTONS.setupPin.label,
      },
    ]
  );
}

async function clearPinSetupState(phoneE164: string): Promise<void> {
  await updateLinkMetadata(phoneE164, {
    pinSetupStep: null,
    pinSetupDraft: null,
  });
}

async function finishWhatsappPinSetup(input: {
  phoneE164: string;
  userId: string;
  conversationId: string;
}): Promise<void> {
  await updateLinkMetadata(input.phoneE164, { introShown: true });
  await deliverWhatsappReplies(
    input.phoneE164,
    input.userId,
    input.conversationId,
    [
      {
        role: 'assistant',
        type: 'text',
        content: pinSecuredMessage(),
      },
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

/**
 * Legacy in-chat PIN handler — kept only so mid-flow users aren't stuck.
 * New setups use WhatsApp Flow (or CTA fallback).
 */
export async function handleWhatsappPinSetupMessage(input: {
  phoneE164: string;
  userId: string;
  conversationId: string;
  text: string;
}): Promise<boolean> {
  const meta = await getLinkMetadata(input.phoneE164);
  const state = readPinSetup(meta);
  if (!state.pinSetupStep) return false;

  const digits = input.text.replace(/\D/g, '');
  if (!/^\d{4}$/.test(digits)) {
    await startWhatsappPinSetup(input);
    return true;
  }

  if (state.pinSetupStep === 'enter') {
    await updateLinkMetadata(input.phoneE164, {
      pinSetupStep: 'confirm',
      pinSetupDraft: digits,
    });
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      input.conversationId,
      [
        {
          role: 'assistant',
          type: 'text',
          content: 'Got it. Enter the same PIN again to confirm.',
        },
      ]
    );
    return true;
  }

  const draft = state.pinSetupDraft ?? '';
  try {
    await setupTransactionPin({
      userId: input.userId,
      pin: draft,
      confirmPin: digits,
    });
    await clearPinSetupState(input.phoneE164);
    await finishWhatsappPinSetup(input);
    return true;
  } catch (err) {
    const message =
      err instanceof FourError
        ? err.message
        : 'Could not save your PIN. Please try again.';

    if (err instanceof FourError && err.code === 'pin_mismatch') {
      await clearPinSetupState(input.phoneE164);
      await startWhatsappPinSetup(input);
      return true;
    }

    await clearPinSetupState(input.phoneE164);
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      input.conversationId,
      [
        {
          role: 'assistant',
          type: 'text',
          content: message,
        },
      ]
    );
    return true;
  }
}
