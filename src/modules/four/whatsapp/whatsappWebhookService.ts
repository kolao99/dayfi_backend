import { normalizePhoneE164 } from '../../../shared/utils/phoneE164';
import {
  isWhatsappStubMode,
  isWhatsappContentApiEnabled,
  type OutboundWhatsappMessage,
} from './whatsappClient';
import { sendWhatsappQuickReply } from './whatsappContentService';
import { parseTwilioWhatsappAddress } from './twilioProvider';
import { resolveWhatsappSession } from './whatsappIdentityService';
import { routeWhatsappText } from './whatsappRouter';
import { runWithTwimlReplies } from './whatsappReplyContext';
import {
  parseTwilioInbound,
  type TwilioWhatsappInbound,
} from './twilioProvider';
import {
  parseMetaInbound,
  sendMetaTypingIndicator,
  type MetaWhatsappInbound,
} from './metaCloudProvider';
import { isMetaWhatsappProvider } from './whatsappProviderEnv';

export type TwilioWhatsappWebhookBody = Record<string, unknown>;

export async function processMetaWhatsappWebhook(body: unknown): Promise<void> {
  const inbounds = parseMetaInbound(body);
  for (const inbound of inbounds) {
    await handleMetaInboundMessage(inbound).catch((err) => {
      console.error('[four/whatsapp] Meta inbound message failed', err);
    });
  }
}

export async function processWhatsappWebhook(
  body: TwilioWhatsappWebhookBody
): Promise<{ ok: boolean; reason?: string; twimlBodies?: string[] }> {
  const inbound = parseTwilioInbound(body);
  if (!inbound) {
    return { ok: true, reason: 'ignored_empty' };
  }

  if (!inbound.body) {
    return { ok: true, reason: 'ignored_non_text' };
  }

  const runHandler = async () => {
    await handleInboundMessage(inbound).catch((err) => {
      console.error('[four/whatsapp] inbound handler failed', err);
    });
  };

  if (isWhatsappStubMode()) {
    await runHandler();
    return { ok: true, reason: 'message' };
  }

  const { bodies, contentReplies } = await runWithTwimlReplies(runHandler);
  if (isWhatsappContentApiEnabled()) {
    await flushContentReplies(contentReplies);
  }
  return { ok: true, reason: 'message', twimlBodies: bodies };
}

async function flushContentReplies(
  replies: OutboundWhatsappMessage[]
): Promise<void> {
  if (!replies.length) return;

  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();
  if (!accountSid || !authToken || !from) return;

  for (const reply of replies) {
    const buttons = (reply.buttons ?? [])
      .filter((b) => !b.disabled)
      .slice(0, 3);
    if (!buttons.length) continue;

    try {
      await sendWhatsappQuickReply({
        accountSid,
        authToken,
        from: parseTwilioWhatsappAddress(from),
        toPhoneE164: reply.toPhoneE164,
        body: reply.text,
        buttons,
      });
    } catch (err) {
      console.error('[four/whatsapp] quick-reply send failed', err);
    }
  }
}

async function handleMetaInboundMessage(
  inbound: MetaWhatsappInbound
): Promise<void> {
  const normalized = normalizePhoneE164(inbound.fromPhoneE164);
  if (!normalized.ok) {
    console.warn(
      `[four/whatsapp] invalid phone from Meta: ${inbound.fromPhoneE164}`
    );
    return;
  }

  // Show "Azap is typing…" immediately while we process the reply.
  void sendMetaTypingIndicator(inbound.messageId).catch((err) => {
    console.warn('[four/whatsapp] typing indicator error', err);
  });

  try {
    const session = await resolveWhatsappSession({
      phoneE164: normalized.e164,
      profileName: inbound.profileName,
    });

    if (inbound.flowReply) {
      const { handleWhatsappPinFlowCompletion } = await import(
        './flows/handlePinFlowCompletion'
      );
      const handled = await handleWhatsappPinFlowCompletion({
        phoneE164: normalized.e164,
        userId: session.user.user_id,
        flowToken: inbound.flowReply.flowToken,
        response: inbound.flowReply.response,
      });
      if (handled) return;
    }

    const firstName =
      session.user.first_name || inbound.profileName?.split(/\s+/)[0] || 'Friend';

    await routeWhatsappText({
      userId: session.user.user_id,
      phoneE164: normalized.e164,
      text: inbound.body,
      buttonPayload: inbound.buttonPayload,
      firstName,
      inboundMessageId: inbound.messageId,
    });
  } catch (err) {
    console.error('[four/whatsapp] Meta inbound message failed', err);
    try {
      const { sendWhatsappMessage } = await import('./whatsappClient');
      await sendWhatsappMessage({
        toPhoneE164: normalized.e164,
        text:
          'Sorry, something went wrong while processing that. Please try again in a moment.',
      });
    } catch (fallbackErr) {
      console.error(
        '[four/whatsapp] fallback reply failed',
        fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
      );
    }
  }
}

async function handleInboundMessage(
  inbound: TwilioWhatsappInbound
): Promise<void> {
  const normalized = normalizePhoneE164(inbound.fromPhoneE164);
  if (!normalized.ok) {
    console.warn(
      `[four/whatsapp] invalid phone from Twilio: ${inbound.fromPhoneE164}`
    );
    return;
  }

  const session = await resolveWhatsappSession({
    phoneE164: normalized.e164,
    profileName: inbound.profileName,
  });

  const firstName =
    session.user.first_name || inbound.profileName?.split(/\s+/)[0] || 'Friend';

  await routeWhatsappText({
    userId: session.user.user_id,
    phoneE164: normalized.e164,
    text: inbound.body,
    buttonPayload: inbound.buttonPayload,
    firstName,
    inboundMessageId: inbound.messageSid,
  });
}

export function isWhatsappWebhookMetaMode(): boolean {
  return isMetaWhatsappProvider();
}
