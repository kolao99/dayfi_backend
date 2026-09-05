import { createWhatsappFlowToken } from './flowToken';
import { whatsappButtonTitle } from '../whatsappContentService';
import type { BillCategoryCode } from '../../finance/billPaymentFlow';
import {
  AZAP_BILL_FLOW_NAMES,
  billFlowCtaLabel,
  billFlowIntro,
} from './billFlowJson';

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

function envFlowId(category: BillCategoryCode): string {
  const map: Record<BillCategoryCode, string> = {
    AIRTIME: 'META_WHATSAPP_FLOW_AIRTIME_ID',
    MOBILEDATA: 'META_WHATSAPP_FLOW_DATA_ID',
    UTILITYBILLS: 'META_WHATSAPP_FLOW_ELECTRICITY_ID',
    CABLEBILLS: 'META_WHATSAPP_FLOW_TV_ID',
    INTSERVICE: 'META_WHATSAPP_FLOW_INTERNET_ID',
  };
  return String(process.env[map[category]] || '').trim();
}

export function isWhatsappBillFlowConfigured(
  category: BillCategoryCode
): boolean {
  return Boolean(envFlowId(category) || AZAP_BILL_FLOW_NAMES[category]);
}

/**
 * Sends an interactive WhatsApp Flow for a bill category.
 * Falls back to conversational bills when Meta integrity blocks send (139000).
 */
export async function sendWhatsappBillFlow(input: {
  toPhoneE164: string;
  userId: string;
  category: BillCategoryCode;
  bodyText?: string;
}): Promise<{ messageId: string | null }> {
  const token = metaAccessToken();
  const phoneNumberId = metaPhoneNumberId();
  const flowId = envFlowId(input.category);
  const flowName = AZAP_BILL_FLOW_NAMES[input.category];

  if (!token || !phoneNumberId) {
    throw new Error('Meta WhatsApp credentials are required for Flows.');
  }

  const to = String(input.toPhoneE164 || '').replace(/\D/g, '');
  const flowToken = createWhatsappFlowToken({
    userId: input.userId,
    purpose: 'bill',
    category: input.category,
  });

  const flowMode = String(
    process.env.META_WHATSAPP_BILL_FLOW_MODE ||
      process.env.META_WHATSAPP_PIN_FLOW_MODE ||
      ''
  )
    .trim()
    .toLowerCase();

  const parameters: Record<string, unknown> = {
    flow_message_version: '3',
    flow_token: flowToken,
    flow_cta: whatsappButtonTitle(billFlowCtaLabel(input.category)),
    flow_action: 'navigate',
    flow_action_payload: {
      screen: 'DETAILS',
    },
  };
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
      body: {
        text: input.bodyText || billFlowIntro(input.category),
      },
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
    error?: { message?: string; error_user_msg?: string; code?: number };
  };

  if (!res.ok) {
    const err = new Error(
      data.error?.error_user_msg ||
        data.error?.message ||
        `Meta Bill Flow send failed (${res.status})`
    ) as Error & { code?: number };
    err.code = data.error?.code;
    throw err;
  }

  return { messageId: data.messages?.[0]?.id ?? null };
}

export { billFlowIntro, billFlowCtaLabel };
