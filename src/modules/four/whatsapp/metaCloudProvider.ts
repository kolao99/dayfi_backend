import crypto from 'crypto';
import type { ChoiceButton } from '../telegram/onboardingService';
import { whatsappButtonTitle } from './whatsappContentService';

export type MetaWhatsappInbound = {
  messageId: string;
  fromPhoneE164: string;
  body: string;
  buttonPayload?: string;
  profileName?: string;
  /** WhatsApp Flow completion (nfm_reply) */
  flowReply?: {
    flowToken: string;
    response: Record<string, unknown>;
  };
};

const GRAPH_VERSION =
  String(process.env.META_WHATSAPP_GRAPH_VERSION || 'v21.0').trim() ||
  'v21.0';

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path.replace(/^\//, '')}`;
}

function metaAccessToken(): string {
  return String(process.env.META_WHATSAPP_ACCESS_TOKEN || '').trim();
}

function metaPhoneNumberId(): string {
  return String(process.env.META_WHATSAPP_PHONE_NUMBER_ID || '').trim();
}

function metaVerifyToken(): string {
  return String(process.env.META_WHATSAPP_VERIFY_TOKEN || '').trim();
}

function metaAppSecret(): string {
  return String(process.env.META_WHATSAPP_APP_SECRET || '').trim();
}

/** Meta GET webhook verification (Step 2 "Verify and save"). */
export function verifyMetaWebhookSubscribe(
  query: Record<string, unknown>
): { ok: true; challenge: string } | { ok: false; reason: string } {
  const mode = String(query['hub.mode'] ?? '').trim();
  const token = String(query['hub.verify_token'] ?? '').trim();
  const challenge = String(query['hub.challenge'] ?? '').trim();
  const expected = metaVerifyToken();

  if (!expected) {
    return { ok: false, reason: 'META_WHATSAPP_VERIFY_TOKEN is not set' };
  }
  if (mode !== 'subscribe') {
    return { ok: false, reason: 'invalid hub.mode' };
  }
  if (token !== expected) {
    return { ok: false, reason: 'verify token mismatch' };
  }
  if (!challenge) {
    return { ok: false, reason: 'missing hub.challenge' };
  }

  return { ok: true, challenge };
}

export function validateMetaWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  const secret = metaAppSecret();
  if (!secret) return true;

  const header = String(signatureHeader || '').trim();
  if (!header.startsWith('sha256=')) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(header)
    );
  } catch {
    return false;
  }
}

function toMetaRecipient(phoneE164: string): string {
  return String(phoneE164 || '').replace(/\D/g, '');
}

function toE164(waId: string): string {
  const digits = String(waId || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/** Parse Meta Cloud API webhook JSON into inbound user messages. */
export function parseMetaInbound(body: unknown): MetaWhatsappInbound[] {
  const root = body as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          messages?: Array<Record<string, unknown>>;
        };
      }>;
    }>;
  };

  if (root?.object !== 'whatsapp_business_account') return [];

  const out: MetaWhatsappInbound[] = [];

  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const contacts = value?.contacts ?? [];
      const contactName = contacts[0]?.profile?.name;

      for (const message of value?.messages ?? []) {
        const messageId = String(message.id ?? '').trim();
        const from = toE164(String(message.from ?? ''));
        if (!messageId || !from) continue;

        const type = String(message.type ?? '').trim();
        let text = '';
        let buttonPayload: string | undefined;

        if (type === 'text') {
          const textBody = message.text as { body?: string } | undefined;
          text = String(textBody?.body ?? '').trim();
        } else if (type === 'interactive') {
          const interactive = message.interactive as
            | {
                type?: string;
                button_reply?: { id?: string; title?: string };
                list_reply?: { id?: string; title?: string };
                nfm_reply?: {
                  response_json?: string;
                  body?: string;
                  name?: string;
                };
              }
            | undefined;
          if (interactive?.nfm_reply?.response_json) {
            let response: Record<string, unknown> = {};
            try {
              response = JSON.parse(
                interactive.nfm_reply.response_json
              ) as Record<string, unknown>;
            } catch {
              response = {};
            }
            const flowToken = String(
              response.flow_token ?? response.flowToken ?? ''
            ).trim();
            out.push({
              messageId,
              fromPhoneE164: from,
              body: '[flow_completed]',
              profileName: contactName,
              flowReply: {
                flowToken,
                response,
              },
            });
            continue;
          }
          if (interactive?.button_reply) {
            buttonPayload = String(interactive.button_reply.id ?? '').trim();
            text = String(
              interactive.button_reply.title ?? buttonPayload
            ).trim();
          } else if (interactive?.list_reply) {
            buttonPayload = String(interactive.list_reply.id ?? '').trim();
            text = String(
              interactive.list_reply.title ?? buttonPayload
            ).trim();
          }
        } else if (type === 'button') {
          const button = message.button as
            | { payload?: string; text?: string }
            | undefined;
          buttonPayload = String(button?.payload ?? '').trim() || undefined;
          text = String(button?.text ?? buttonPayload ?? '').trim();
        }

        if (!text && !buttonPayload) continue;

        out.push({
          messageId,
          fromPhoneE164: from,
          body: text || buttonPayload || '',
          buttonPayload,
          profileName: contactName,
        });
      }
    }
  }

  return out;
}

function buildInteractiveButtons(buttons: ChoiceButton[]) {
  const active = buttons.filter((b) => !b.disabled).slice(0, 3);
  if (!active.length) return null;

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      action: {
        buttons: active.map((button) => ({
          type: 'reply',
          reply: {
            id: button.id,
            title: whatsappButtonTitle(button.label),
          },
        })),
      },
    },
  };
}

function buildCtaUrlInteractive(input: {
  text: string;
  url: string;
  label: string;
}) {
  return {
    type: 'cta_url',
    body: { text: input.text },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: whatsappButtonTitle(input.label),
        url: input.url,
      },
    },
  };
}

export async function sendMetaCloudWhatsappMessage(input: {
  toPhoneE164: string;
  text: string;
  buttons?: ChoiceButton[];
  ctaUrl?: string | null;
  ctaLabel?: string | null;
}): Promise<{ messageId: string | null }> {
  const token = metaAccessToken();
  const phoneNumberId = metaPhoneNumberId();
  if (!token || !phoneNumberId) {
    throw new Error(
      'META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID are required.'
    );
  }

  const to = toMetaRecipient(input.toPhoneE164);
  const ctaUrl = String(input.ctaUrl || '').trim();
  const ctaLabel = String(input.ctaLabel || 'Open').trim();
  const activeButtons = (input.buttons ?? []).filter((b) => !b.disabled);
  const interactiveButtons =
    !ctaUrl && activeButtons.length > 0
      ? buildInteractiveButtons(activeButtons)
      : null;

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
  };

  if (ctaUrl) {
    payload.type = 'interactive';
    payload.interactive = buildCtaUrlInteractive({
      text: input.text,
      url: ctaUrl,
      label: ctaLabel,
    });
  } else if (interactiveButtons) {
    payload.type = 'interactive';
    payload.interactive = {
      ...(interactiveButtons.interactive as Record<string, unknown>),
      body: { text: input.text },
    };
  } else {
    payload.type = 'text';
    payload.text = { preview_url: false, body: input.text };
  }

  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(
      data.error?.message || `Meta WhatsApp send failed (${res.status})`
    );
  }

  return { messageId: data.messages?.[0]?.id ?? null };
}

/**
 * Mark an inbound message as read and show the WhatsApp "…" typing dots
 * while Azap prepares a reply. Dismisses when we send a response or after ~25s.
 */
export async function sendMetaTypingIndicator(
  inboundMessageId: string
): Promise<boolean> {
  const token = metaAccessToken();
  const phoneNumberId = metaPhoneNumberId();
  const messageId = String(inboundMessageId || '').trim();
  if (!token || !phoneNumberId || !messageId) return false;

  const res = await fetch(graphUrl(`${phoneNumberId}/messages`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    console.warn(
      '[four/whatsapp] typing indicator failed',
      data.error?.message || res.status
    );
    return false;
  }

  return true;
}
