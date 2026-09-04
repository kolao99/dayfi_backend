import type { ChoiceButton } from '../telegram/onboardingService';
import { sendMetaCloudWhatsappMessage } from './metaCloudProvider';
import {
  createWhatsappSecureToken,
  type WhatsappSecurePurpose,
} from './whatsappSecureToken';
import {
  parseTwilioWhatsappAddress,
  sendTwilioWhatsappMessage,
} from './twilioProvider';
import {
  resolveWhatsappProvider,
  isMetaWhatsappProvider,
} from './whatsappProviderEnv';
import {
  pushTwimlReply,
  twimlReplyActive,
} from './whatsappReplyContext';

function contentApiEnabled(): boolean {
  return (
    String(process.env.FOUR_WHATSAPP_CONTENT_API || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

export function isWhatsappContentApiEnabled(): boolean {
  return contentApiEnabled();
}

export type OutboundWhatsappMessage = {
  toPhoneE164: string;
  text: string;
  buttons?: ChoiceButton[];
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  messageSid?: string;
};

const outboundStub: OutboundWhatsappMessage[] = [];
let stubCounter = 1;

export function isWhatsappStubMode(): boolean {
  return resolveWhatsappProvider() === 'stub';
}

export function drainStubWhatsappOutbound(): OutboundWhatsappMessage[] {
  return outboundStub.splice(0, outboundStub.length);
}

export function resetStubWhatsappOutbound(): void {
  outboundStub.length = 0;
  stubCounter = 1;
}

export function whatsappSecureUrl(options?: {
  mode?: WhatsappSecurePurpose;
  intent?: string;
  userId?: string;
}): string | null {
  const base = String(
    process.env.FOUR_WHATSAPP_SECURE_URL ||
      process.env.FOUR_TELEGRAM_MINI_APP_URL ||
      process.env.DAYFI_APP_URL ||
      ''
  ).trim();
  if (!base || !options?.userId) return null;

  const mode = options.mode ?? (options.intent ? 'authorize' : null);
  if (!mode) return null;

  try {
    const url = new URL(base.includes('://') ? base : `https://${base}`);
    if (mode === 'setup') {
      url.pathname = '/setup-pin';
    } else if (mode === 'kyc') {
      url.pathname = '/kyc';
    } else {
      url.pathname = '/authorize';
      if (options.intent) {
        url.searchParams.set('intent', options.intent);
      }
    }

    url.searchParams.set(
      't',
      createWhatsappSecureToken({
        userId: options.userId,
        purpose: mode,
        intentId: options.intent,
      })
    );
    return url.toString();
  } catch {
    return null;
  }
}

/** Append quick-reply hints — native WhatsApp buttons send this text back. */
export function appendButtonHints(
  text: string,
  buttons: ChoiceButton[]
): string {
  if (!buttons.length) return text;
  const active = buttons.filter((b) => !b.disabled);
  if (!active.length) return text;

  const lines = active.map((b) => {
    const hint = b.userText?.trim() || b.label.trim();
    return `• ${hint}`;
  });
  return `${text}\n\n${lines.join('\n')}`;
}

export async function sendWhatsappMessage(
  message: OutboundWhatsappMessage
): Promise<{ messageSid?: string }> {
  if (isWhatsappStubMode()) {
    const sid = `stub_wa_${stubCounter++}`;
    outboundStub.push({ ...message, messageSid: sid });
    return { messageSid: sid };
  }

  // Webhook replies must return in TwiML — trial accounts cannot use Content API.
  if (twimlReplyActive()) {
    const activeButtons = (message.buttons ?? []).filter((b) => !b.disabled);
    let text = message.text;
    if (activeButtons.length > 0) {
      text = appendButtonHints(text, activeButtons);
    }
    pushTwimlReply(text);
    return { messageSid: 'twiml' };
  }

  if (isMetaWhatsappProvider()) {
    const activeButtons = (message.buttons ?? []).filter((b) => !b.disabled);
    const result = await sendMetaCloudWhatsappMessage({
      toPhoneE164: message.toPhoneE164,
      text: message.text,
      buttons: activeButtons.length > 0 ? activeButtons : undefined,
      ctaUrl: message.ctaUrl,
      ctaLabel: message.ctaLabel,
    });
    return { messageSid: result.messageId ?? undefined };
  }

  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = parseTwilioWhatsappAddress(
    String(process.env.TWILIO_WHATSAPP_FROM || '').trim()
  );

  if (!accountSid || !authToken || !from) {
    throw new Error(
      'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM are required for WhatsApp.'
    );
  }

  const result = await sendTwilioWhatsappMessage({
    accountSid,
    authToken,
    from,
    to: message.toPhoneE164,
    body: message.text,
  });

  return { messageSid: result.sid ?? undefined };
}
