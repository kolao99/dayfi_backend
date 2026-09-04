import { createWhatsappFlowToken } from './flowToken';
import { whatsappButtonTitle } from '../whatsappContentService';

function metaAccessToken(): string {
  return String(process.env.META_WHATSAPP_ACCESS_TOKEN || '').trim();
}

function metaPhoneNumberId(): string {
  return String(process.env.META_WHATSAPP_PHONE_NUMBER_ID || '').trim();
}

function graphUrl(path: string): string {
  const version =
    String(process.env.META_WHATSAPP_GRAPH_VERSION || 'v21.0').trim() ||
    'v21.0';
  return `https://graph.facebook.com/${version}/${path.replace(/^\//, '')}`;
}

export function metaPinSetupFlowId(): string {
  return String(process.env.META_WHATSAPP_PIN_FLOW_ID || '').trim();
}

export function metaPinSetupFlowName(): string {
  return String(process.env.META_WHATSAPP_PIN_FLOW_NAME || '').trim();
}

export function isWhatsappPinFlowConfigured(): boolean {
  return Boolean(metaPinSetupFlowId() || metaPinSetupFlowName());
}

/**
 * Sends an interactive WhatsApp Flow message — opens native in-chat bottom sheet.
 * Requires a published Flow (META_WHATSAPP_PIN_FLOW_ID or _NAME).
 */
export async function sendWhatsappPinSetupFlow(input: {
  toPhoneE164: string;
  userId: string;
  bodyText: string;
  ctaLabel?: string;
}): Promise<{ messageId: string | null }> {
  const token = metaAccessToken();
  const phoneNumberId = metaPhoneNumberId();
  const flowId = metaPinSetupFlowId();
  const flowName = metaPinSetupFlowName();

  if (!token || !phoneNumberId) {
    throw new Error('Meta WhatsApp credentials are required for Flows.');
  }
  if (!flowId && !flowName) {
    throw new Error(
      'META_WHATSAPP_PIN_FLOW_ID or META_WHATSAPP_PIN_FLOW_NAME is required.'
    );
  }

  const to = String(input.toPhoneE164 || '').replace(/\D/g, '');
  const flowToken = createWhatsappFlowToken({
    userId: input.userId,
    purpose: 'pin_setup',
  });

  const flowMode = String(process.env.META_WHATSAPP_PIN_FLOW_MODE || '')
    .trim()
    .toLowerCase();

  const parameters: Record<string, unknown> = {
    flow_message_version: '3',
    flow_token: flowToken,
    flow_cta: whatsappButtonTitle(input.ctaLabel || 'Set up your PIN'),
    flow_action: 'navigate',
    flow_action_payload: {
      screen: 'ENTER_PIN',
    },
  };
  // Unpublished Flows can be tested with mode=draft (same WABA admins / testers).
  if (flowMode === 'draft') parameters.mode = 'draft';
  if (flowId) parameters.flow_id = flowId;
  else parameters.flow_name = flowName;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: input.bodyText },
      action: {
        name: 'flow',
        parameters,
      },
    },
  };

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
    error?: { message?: string; error_user_msg?: string };
  };

  if (!res.ok) {
    throw new Error(
      data.error?.error_user_msg ||
        data.error?.message ||
        `Meta Flow send failed (${res.status})`
    );
  }

  return { messageId: data.messages?.[0]?.id ?? null };
}
