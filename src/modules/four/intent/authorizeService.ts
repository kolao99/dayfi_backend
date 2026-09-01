import { db } from '../../../config/database';
import { appendMessage } from '../conversation/messageService';
import { FourError } from '../errors';
import {
  getIntentForUser,
  updateIntent,
  toPublicIntent,
} from '../intent/intentService';
import { executeBankSend, verifyUserPin } from '../finance/sendExecutor';
import type { ResolvedRecipient } from '../finance/recipientResolver';
import { formatMoney } from '../../payment/walletModel';
import {
  getLinkByUserId,
} from '../telegram/telegramLinkService';
import { sendTelegramMessage } from '../telegram/telegramClient';

const AUTHORIZABLE = new Set(['AWAITING_AUTHORIZATION']);

export function sanitizeIntentForMiniApp(intent: ReturnType<typeof toPublicIntent>) {
  const slots = { ...(intent.slots as Record<string, unknown>) };
  const recipient = slots.recipient as Record<string, unknown> | undefined;
  if (recipient?.accountNumber) {
    const acct = String(recipient.accountNumber);
    slots.recipient = {
      ...recipient,
      accountNumber: acct.length > 4 ? `••••${acct.slice(-4)}` : '••••',
    };
  }
  return { ...intent, slots };
}

export async function authorizeIntentWithPin(input: {
  userId: string;
  intentId: string;
  pin: string;
}): Promise<{
  intent: ReturnType<typeof toPublicIntent>;
  execution: { reference: string; message: string };
}> {
  const intent = await getIntentForUser(input.userId, input.intentId);
  if (!intent) {
    throw new FourError('intent_not_found');
  }
  if (!AUTHORIZABLE.has(intent.status)) {
    throw new FourError('intent_invalid_state');
  }
  if (intent.intent !== 'SEND_MONEY') {
    throw new FourError('intent_invalid_state');
  }

  const pinRow = await db.oneOrNone<{ transaction_pin: string | null }>(
    `SELECT transaction_pin FROM users WHERE user_id = $1`,
    [input.userId]
  );
  if (!pinRow?.transaction_pin) {
    throw new FourError('pin_not_set');
  }

  const pinOk = await verifyUserPin(input.userId, input.pin);
  if (!pinOk) {
    throw new FourError('pin_invalid');
  }

  const slots = intent.slots as {
    amount?: number;
    currency?: string;
    recipient?: ResolvedRecipient;
  };

  if (!slots.amount || !slots.recipient) {
    throw new FourError('intent_invalid_state');
  }

  await updateIntent(input.userId, intent.id, { status: 'PROCESSING' });

  try {
    const execution = await executeBankSend({
      userId: input.userId,
      amount: Number(slots.amount),
      recipient: slots.recipient,
    });

    const completed = await updateIntent(input.userId, intent.id, {
      status: 'COMPLETED',
      metadata: {
        ...(intent.metadata as Record<string, unknown>),
        reference: execution.reference,
      },
    });

    await appendMessage({
      userId: input.userId,
      conversationId: intent.conversation_id,
      role: 'assistant',
      type: 'receipt',
      content: execution.message,
      metadata: {
        intentId: intent.id,
        reference: execution.reference,
        amount: slots.amount,
        currency: slots.currency ?? 'NGN',
      },
    });

    const link = await getLinkByUserId(input.userId);
    if (link?.chat_id) {
      await sendTelegramMessage({
        chatId: link.chat_id,
        text: execution.message,
      });
    }

    return {
      intent: toPublicIntent(completed!),
      execution,
    };
  } catch (err) {
    await updateIntent(input.userId, intent.id, {
      status: 'FAILED',
      metadata: {
        ...(intent.metadata as Record<string, unknown>),
        error: err instanceof Error ? err.message : 'Transfer failed',
      },
    });

    const message =
      err instanceof Error
        ? err.message
        : "The payment couldn't be completed. Please try again.";

    await appendMessage({
      userId: input.userId,
      conversationId: intent.conversation_id,
      role: 'assistant',
      type: 'error',
      content: `❌ ${message}`,
    });

    const link = await getLinkByUserId(input.userId);
    if (link?.chat_id) {
      await sendTelegramMessage({
        chatId: link.chat_id,
        text: `❌ ${message}`,
      });
    }

    throw new FourError('transfer_failed');
  }
}

export function buildReviewSummary(intent: ReturnType<typeof toPublicIntent>): string {
  const slots = intent.slots as {
    amount?: number;
    currency?: string;
    recipient?: ResolvedRecipient;
  };
  const amount = Number(slots.amount ?? 0);
  const currency = String(slots.currency ?? 'NGN');
  const name = slots.recipient?.name ?? 'Recipient';
  return `Send ${formatMoney(amount, currency)} to ${name}`;
}
