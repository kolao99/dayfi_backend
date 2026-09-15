/**
 * Lightweight dialogue context for pronouns / "another 10k".
 * Persists in azap_conversation_state.resolvedEntities — never executes money.
 */

import {
  ensureConversationState,
  patchConversationState,
} from './stateService';
import type { AzapChannel } from './stateTypes';

export type LastMoneyContext = {
  recipientName?: string;
  bankName?: string;
  accountNumber?: string;
  amount?: number;
  currency?: string;
  intent?: string;
};

export async function rememberMoneyContext(input: {
  userId: string;
  conversationId: string;
  channel?: AzapChannel;
  context: LastMoneyContext;
}): Promise<void> {
  try {
    await ensureConversationState({
      userId: input.userId,
      channel: input.channel || 'whatsapp',
      conversationId: input.conversationId,
    });
    await patchConversationState(input.conversationId, {
      resolvedEntities: {
        lastMoney: {
          ...input.context,
          at: new Date().toISOString(),
        },
      },
      currentIntent: input.context.intent || null,
    });
  } catch (err) {
    console.warn(
      '[azap/dialogue] rememberMoneyContext failed',
      err instanceof Error ? err.message : err
    );
  }
}

export async function getLastMoneyContext(
  conversationId: string
): Promise<LastMoneyContext | null> {
  try {
    const { getConversationState } = await import('./stateService');
    const state = await getConversationState(conversationId);
    const last = state?.resolvedEntities?.lastMoney;
    if (!last || typeof last !== 'object') return null;
    return last as LastMoneyContext;
  } catch {
    return null;
  }
}

/**
 * Resolve "him" / "her" / "same person" / "that person" to last recipient name.
 */
export function resolvePronounRecipient(
  text: string,
  last: LastMoneyContext | null
): string | null {
  if (!last?.recipientName) return null;
  const q = text.toLowerCase();
  if (
    /\b(him|her|them|same (one|person|guy|babe)|that (guy|person|one)|the same)\b/.test(
      q
    )
  ) {
    return last.recipientName;
  }
  return null;
}
