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
import { deliverAzapPush } from '../finance/azapNotifyService';

const AUTHORIZABLE = new Set(['AWAITING_AUTHORIZATION']);

export function sanitizeIntentForMiniApp(
  intent: ReturnType<typeof toPublicIntent>
) {
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
  if (intent.intent !== 'SEND_MONEY' && intent.intent !== 'SEND_CRYPTO' && intent.intent !== 'PAY_BILL' && intent.intent !== 'SEND_YC') {
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

  await updateIntent(input.userId, intent.id, { status: 'PROCESSING' });

  try {
    let execution: { reference: string; message: string };

    if (intent.intent === 'SEND_CRYPTO') {
      const cryptoSlots = intent.slots as {
        amount?: string;
        asset?: string;
        network?: string;
        to?: string;
      };
      if (
        !cryptoSlots.amount ||
        !cryptoSlots.asset ||
        !cryptoSlots.network ||
        !cryptoSlots.to
      ) {
        throw new FourError('intent_invalid_state');
      }
      const { executeCryptoSendFromSlots } = await import(
        '../finance/cryptoSendFlow'
      );
      const { recordCryptoOutboundLedger } = await import(
        '../../payment/cryptoOutboundLedgerService'
      );
      const sent = await executeCryptoSendFromSlots({
        userId: input.userId,
        amount: String(cryptoSlots.amount),
        asset: String(cryptoSlots.asset),
        network: String(cryptoSlots.network),
        to: String(cryptoSlots.to),
      });
      await recordCryptoOutboundLedger({
        userId: input.userId,
        amount: String(cryptoSlots.amount),
        asset: String(cryptoSlots.asset),
        network: String(cryptoSlots.network),
        txHash: sent.hash,
        to: String(cryptoSlots.to),
        from: '',
      });
      execution = { reference: sent.hash, message: sent.message };
    } else if (intent.intent === 'PAY_BILL') {
      const { executeBillPayFromSlots } = await import(
        '../finance/billPaymentFlow'
      );
      execution = await executeBillPayFromSlots({
        userId: input.userId,
        slots: intent.slots as Record<string, unknown>,
      });
    } else if (intent.intent === 'SEND_YC') {
      const { executeYellowCardSendFromSlots } = await import(
        '../finance/yellowCardSendFlow'
      );
      execution = await executeYellowCardSendFromSlots({
        userId: input.userId,
        slots: intent.slots as Record<string, unknown>,
      });
    } else {
      const slots = intent.slots as {
        amount?: number;
        currency?: string;
        recipient?: ResolvedRecipient;
      };
      if (!slots.amount || !slots.recipient) {
        throw new FourError('intent_invalid_state');
      }
      execution = await executeBankSend({
        userId: input.userId,
        amount: Number(slots.amount),
        recipient: slots.recipient,
      });
    }

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
        amount: (intent.slots as { amount?: unknown }).amount,
        currency:
          (intent.slots as { currency?: string; asset?: string }).currency ??
          (intent.slots as { asset?: string }).asset ??
          'NGN',
      },
    });

    await deliverAzapPush(input.userId, execution.message, { persist: false });

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

    const rawMessage =
      err instanceof Error
        ? err.message
        : "The payment couldn't be completed. Please try again.";

    await appendMessage({
      userId: input.userId,
      conversationId: intent.conversation_id,
      role: 'assistant',
      type: 'error',
      content: `❌ ${rawMessage}`,
    });

    await deliverAzapPush(input.userId, `❌ ${rawMessage}`, { persist: false });

    // Preserve provider/Dayfi reason for clients instead of a generic transfer_failed.
    const fail = new FourError('transfer_failed');
    (fail as Error & { cause?: unknown }).cause = err;
    (fail as Error & { detail?: string }).detail = rawMessage;
    throw Object.assign(fail, { message: rawMessage });
  }
}

export function buildReviewSummary(
  intent: ReturnType<typeof toPublicIntent>
): string {
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
