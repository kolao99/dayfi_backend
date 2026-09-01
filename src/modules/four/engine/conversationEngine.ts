import { appendMessage } from '../conversation/messageService';
import {
  cancelActiveIntent,
  getActiveIntentForConversation,
  updateIntent,
  upsertActiveIntent,
} from '../intent/intentService';
import { parseUserMessage } from './intentParser';
import { buildBalanceReply, hasSufficientBalanceForSend } from '../finance/balanceService';
import {
  formatRecipientLine,
  resolveRecipientByName,
  resolveBankName,
} from '../finance/recipientResolver';
import { formatMoney } from '../../payment/walletModel';
import { buildInlineKeyboard } from '../telegram/telegramClient';

export type EngineReply = {
  role: 'assistant';
  type: 'text' | 'choice' | 'review' | 'receipt';
  content: string;
  metadata?: Record<string, unknown>;
};

export type EngineResult = {
  replies: EngineReply[];
  intentId?: string;
};

async function persistAssistant(
  userId: string,
  conversationId: string,
  reply: EngineReply
): Promise<void> {
  await appendMessage({
    userId,
    conversationId,
    role: 'assistant',
    type: reply.type,
    content: reply.content,
    metadata: reply.metadata ?? {},
  });
}

export async function handleUserText(input: {
  userId: string;
  conversationId: string;
  text: string;
}): Promise<EngineResult> {
  const { userId, conversationId, text } = input;
  const parsed = parseUserMessage(text);
  const active = await getActiveIntentForConversation(userId, conversationId);

  if (parsed.kind === 'cancel') {
    await cancelActiveIntent(userId, conversationId);
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: 'Cancelled. What would you like to do next?',
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (
    parsed.kind === 'amount_update' &&
    active?.intent === 'SEND_MONEY' &&
    (active.status === 'AWAITING_CONFIRMATION' ||
      active.status === 'COLLECTING_INFORMATION')
  ) {
    const slots: Record<string, unknown> = {
      ...(active.slots as Record<string, unknown>),
      amount: parsed.amount,
      currency: 'NGN',
    };
    const recipient = slots.recipient as Record<string, unknown> | undefined;
    if (!recipient?.name) {
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: 'Who should I send it to?',
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: active.id };
    }

    const amount = Number(slots.amount);
    const sufficient = await hasSufficientBalanceForSend(userId, amount, 0);
    if (!sufficient) {
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `You don't have enough balance to send ${formatMoney(amount, 'NGN')}.`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: active.id };
    }

    const updated = await updateIntent(userId, active.id, {
      status: 'AWAITING_CONFIRMATION',
      slots,
    });
    const line = formatRecipientLine(recipient as any);
    const reply: EngineReply = {
      role: 'assistant',
      type: 'review',
      content: `Updated.\n\n${line}\n\nYou're sending ${formatMoney(amount, 'NGN')}.\n\nTap below to confirm with your PIN.`,
      metadata: {
        intentId: updated!.id,
        buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: false }],
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: updated!.id };
  }

  if (parsed.kind === 'balance') {
    await cancelActiveIntent(userId, conversationId);
    const balanceText = await buildBalanceReply(userId);
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: balanceText,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'send') {
    let amount = parsed.amount;
    let recipientName = parsed.recipientName;

    if (!recipientName && active?.intent === 'SEND_MONEY') {
      const slots = active.slots as Record<string, unknown>;
      const existing = slots.recipient as { name?: string } | undefined;
      recipientName = existing?.name ?? null;
      if (!amount && slots.amount) amount = Number(slots.amount);
    }

    if (!recipientName) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: { amount, currency: 'NGN' },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: 'Who should I send the money to?',
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }

    const resolved = await resolveRecipientByName(userId, recipientName);
    if (!resolved) {
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `I couldn't find a saved recipient named "${recipientName}". Save them in your contacts first, or check the spelling.`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply] };
    }

    resolved.bankName = await resolveBankName(resolved.bankCode);

    if (!amount || amount <= 0) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: {
          recipient: resolved,
          currency: 'NGN',
        },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `I found ${formatRecipientLine(resolved)}.\n\nHow much would you like to send?`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }

    const sufficient = await hasSufficientBalanceForSend(userId, amount, 0);
    if (!sufficient) {
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `You don't have enough balance to send ${formatMoney(amount, 'NGN')}.`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply] };
    }

    const intent = await upsertActiveIntent({
      userId,
      conversationId,
      intent: 'SEND_MONEY',
      status: 'AWAITING_CONFIRMATION',
      slots: {
        amount,
        currency: 'NGN',
        recipient: resolved,
      },
    });

    const reply: EngineReply = {
      role: 'assistant',
      type: 'review',
      content:
        `I found ${formatRecipientLine(resolved)}.\n\n` +
        `You're sending ${formatMoney(amount, 'NGN')}.\n\n` +
        `Tap below to confirm with your PIN.`,
      metadata: {
        intentId: intent.id,
        buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: false }],
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: intent.id };
  }

  if (
    parsed.kind === 'amount_update' &&
    active?.intent === 'SEND_MONEY' &&
    active.status === 'COLLECTING_INFORMATION'
  ) {
    return handleUserText({
      userId,
      conversationId,
      text: `send ${parsed.amount} to ${(active.slots as any).recipient?.name ?? ''}`,
    });
  }

  const reply: EngineReply = {
    role: 'assistant',
    type: 'text',
    content:
      "I can help with your balance or sending money to a saved contact.\n\nTry:\n• What's my balance?\n• Send ₦20,000 to Kola",
  };
  await persistAssistant(userId, conversationId, reply);
  return { replies: [reply] };
}

export function replyMarkupForReview(
  reply: EngineReply,
  intentId?: string
): Record<string, unknown> | undefined {
  const buttons = (reply.metadata?.buttons as Array<{
    id: string;
    label: string;
    disabled?: boolean;
  }>) ?? [];
  if (!buttons.length && reply.type !== 'review') return undefined;
  return buildInlineKeyboard(buttons, intentId ?? String(reply.metadata?.intentId ?? ''));
}
