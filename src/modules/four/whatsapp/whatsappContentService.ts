import Twilio from 'twilio';
import type { ChoiceButton } from '../telegram/onboardingService';
import { parseTwilioWhatsappAddress } from './twilioProvider';

/** WhatsApp quick-reply button titles are capped at 20 characters. */
export function whatsappButtonTitle(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= 20) return trimmed;

  const withoutLeadingEmoji = trimmed
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\s]+/gu, '')
    .trim();
  if (withoutLeadingEmoji.length <= 20) return withoutLeadingEmoji;

  return withoutLeadingEmoji.slice(0, 20);
}

const contentSidCache = new Map<string, string>();

function twilioClient(accountSid: string, authToken: string) {
  return Twilio(accountSid, authToken);
}

function whatsappAddress(phone: string): string {
  const parsed = parseTwilioWhatsappAddress(phone);
  return parsed.startsWith('whatsapp:') ? parsed : `whatsapp:${parsed}`;
}

async function ensureQuickReplyContentSid(input: {
  accountSid: string;
  authToken: string;
  buttons: ChoiceButton[];
}): Promise<string> {
  const active = input.buttons.filter((b) => !b.disabled).slice(0, 3);
  const cacheKey = active.map((b) => b.id).join('|');
  const cached = contentSidCache.get(cacheKey);
  if (cached) return cached;

  const client = twilioClient(input.accountSid, input.authToken);
  const content = await client.content.v1.contents.create({
    friendlyName: `azap_qr_${cacheKey.replace(/[^a-z0-9_]+/gi, '_')}`.slice(0, 64),
    language: 'en',
    types: {
      'twilio/quick-reply': {
        body: '{{1}}',
        actions: active.map((button) => ({
          type: 'QUICK_REPLY',
          title: whatsappButtonTitle(button.label),
          id: button.id,
        })),
      },
      'twilio/text': {
        body: '{{1}}',
      },
    } as Record<string, unknown>,
  });

  const sid = content.sid;
  contentSidCache.set(cacheKey, sid);
  return sid;
}

export async function sendWhatsappQuickReply(input: {
  accountSid: string;
  authToken: string;
  from: string;
  toPhoneE164: string;
  body: string;
  buttons: ChoiceButton[];
}): Promise<{ sid: string | null }> {
  const active = input.buttons.filter((b) => !b.disabled).slice(0, 3);
  if (!active.length) {
    throw new Error('sendWhatsappQuickReply requires at least one button.');
  }

  const contentSid = await ensureQuickReplyContentSid({
    accountSid: input.accountSid,
    authToken: input.authToken,
    buttons: active,
  });

  const client = twilioClient(input.accountSid, input.authToken);
  const message = await client.messages.create({
    contentSid,
    contentVariables: JSON.stringify({ '1': input.body }),
    from: whatsappAddress(input.from),
    to: whatsappAddress(input.toPhoneE164),
  });

  return { sid: message.sid ?? null };
}
