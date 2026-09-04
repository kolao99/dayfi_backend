import type { ChoiceButton } from './onboardingService';
import { buildInlineKeyboard } from './telegramClient';
import type { EngineReply } from '../engine/conversationEngine';

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
  const resolvedIntentId =
    intentId ?? String(reply.metadata?.intentId ?? '');
  return buildInlineKeyboard(buttons, {
    scope: 'send',
    intentId: resolvedIntentId || undefined,
  });
}

/** WhatsApp-style reply keyboard — tap sends real user message (green bubble). */
export function buildReplyKeyboard(
  buttons: ChoiceButton[]
): Record<string, unknown> {
  return {
    keyboard: buttons.map((b) => [{ text: b.label }]),
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

export function removeReplyKeyboard(): Record<string, unknown> {
  return { remove_keyboard: true };
}
