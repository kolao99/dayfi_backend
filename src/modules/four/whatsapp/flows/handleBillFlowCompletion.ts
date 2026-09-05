/**
 * Apply WhatsApp Bill Flow nfm_reply → same PAY_BILL review/PIN path as chat.
 */
import {
  createConversation,
  getLatestConversation,
} from '../../conversation/conversationService';
import { appendMessage } from '../../conversation/messageService';
import { deliverWhatsappReplies } from '../whatsappDelivery';
import { verifyWhatsappFlowToken } from './flowToken';
import {
  type BillCategoryCode,
  categoryLabel,
  continueBillPayment,
} from '../../finance/billPaymentFlow';
import { whatsappSecureUrl } from '../whatsappClient';

function asCategory(raw: unknown): BillCategoryCode | null {
  const c = String(raw || '').toUpperCase();
  if (
    c === 'AIRTIME' ||
    c === 'MOBILEDATA' ||
    c === 'UTILITYBILLS' ||
    c === 'CABLEBILLS' ||
    c === 'INTSERVICE'
  ) {
    return c;
  }
  return null;
}

function digits(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

function normalizeNgPhone(raw: unknown): string | null {
  const d = digits(raw);
  if (/^0[789]\d{9}$/.test(d)) return d;
  if (/^234[789]\d{9}$/.test(d)) return `0${d.slice(3)}`;
  if (/^[789]\d{9}$/.test(d)) return `0${d}`;
  return d.length >= 10 ? d : null;
}

/**
 * Handle bill Flow completion. Returns true when this reply was a bill flow.
 */
export async function handleWhatsappBillFlowCompletion(input: {
  phoneE164: string;
  userId: string;
  flowToken: string;
  response: Record<string, unknown>;
}): Promise<boolean> {
  const verified = verifyWhatsappFlowToken(input.flowToken);
  if (!verified.ok) return false;
  if (verified.purpose !== 'bill') return false;
  if (verified.userId !== input.userId) {
    console.warn('[azap/flow] bill flow token user mismatch');
    return true;
  }

  const category =
    asCategory(input.response.category) ||
    (verified.category as BillCategoryCode | undefined) ||
    null;
  if (!category) {
    console.warn('[azap/flow] bill flow missing category');
    return true;
  }

  let conversation = await getLatestConversation(input.userId);
  if (!conversation) {
    conversation = await createConversation(input.userId, 'WhatsApp');
  }

  await appendMessage({
    userId: input.userId,
    conversationId: conversation.id,
    role: 'user',
    type: 'event',
    content: `[flow_bill_${category.toLowerCase()}]`,
    metadata: {
      source: 'whatsapp_flow',
      flow: 'bill',
      category,
      channel: 'whatsapp',
    },
  });

  const network = String(
    input.response.network ||
      input.response.disco ||
      input.response.provider ||
      ''
  ).trim();
  const phone =
    normalizeNgPhone(input.response.phone) ||
    normalizeNgPhone(input.response.meter) ||
    normalizeNgPhone(input.response.smartcard) ||
    normalizeNgPhone(input.response.account);
  const amountRaw = input.response.amount;
  const amountNum = Number(
    String(amountRaw ?? '')
      .replace(/,/g, '')
      .replace(/[^\d.]/g, '')
  );

  // Feed the conversational collector with a compact utterance so
  // resolveAirtimeBiller / package resolution stays in BillsService path.
  const bits: string[] = [categoryLabel(category)];
  if (network) bits.push(network);
  if (phone) bits.push(phone);
  if (amountNum > 0) bits.push(`₦${amountNum}`);
  const synthetic = bits.join(' ');

  try {
    const reply = await continueBillPayment({
      userId: input.userId,
      conversationId: conversation.id,
      text: synthetic,
      slots: {
        categoryCode: category,
        billerName: network || undefined,
        customerId: phone || undefined,
        amount: amountNum > 0 ? amountNum : undefined,
      },
    });

    const intentId = (reply as { intentId?: string }).intentId;
    const setupUrl =
      reply.type === 'review' && intentId
        ? whatsappSecureUrl({
            mode: 'authorize',
            userId: input.userId,
            intent: intentId,
          })
        : null;

    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      conversation.id,
      [
        {
          role: 'assistant',
          type: reply.type === 'review' ? 'review' : 'text',
          content: reply.content,
          secureUrl: setupUrl,
          secureLabel: setupUrl ? 'Confirm with PIN' : undefined,
          metadata: reply.metadata,
        },
      ]
    );
  } catch (err) {
    console.error('[azap/flow] bill flow completion failed', err);
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      conversation.id,
      [
        {
          role: 'assistant',
          type: 'text',
          content:
            `I couldn't complete that ${categoryLabel(category).toLowerCase()} request from the form. ` +
            `Tell me in chat — for example: Buy ₦1,000 airtime for 08012345678.`,
        },
      ]
    );
  }

  return true;
}
