/**
 * Route kind for Azap 2.0 dialogue — conversation vs money action.
 * Classification only; never executes payments.
 */

import { parseUserMessage } from '../../four/engine/intentParser';

export type AzapRouteKind =
  | 'conversation'
  | 'action'
  | 'clarification'
  | 'unknown';

const ACTION_KINDS = new Set([
  'balance',
  'balance_in_currency',
  'send',
  'send_prompt',
  'fund',
  'bill_prompt',
  'airtime_prompt',
  'kyc',
  'bank_details',
  'receive_help',
  'tx_history',
  'tx_status',
  'swap_unavailable',
  'unsupported_corridor',
  'send_cost_quote',
  'amount_update',
  'recipient_update',
  'destination_update',
  'cancel',
]);

const CLARIFICATION_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|correct|confirm|no|nah|nope|cancel)[.!\s]*$/i;

const SMALL_TALK_RE =
  /^(thanks?|thank you|thx|cool|nice|ok(ay)?|alright|sharp|wagwan|how far|how you dey|i('m| am) (good|fine|okay|ok)|just got paid|got paid|wetin|sup|what'?s up|how are you|how('?re| are) you)[.!😂🙏❤️]*$/i;

export function classifyRouteKind(
  text: string,
  options?: { hasActiveMoneyIntent?: boolean }
): AzapRouteKind {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 'unknown';

  const parsed = parseUserMessage(trimmed);
  if (ACTION_KINDS.has(parsed.kind) && parsed.kind !== 'unknown') {
    if (
      options?.hasActiveMoneyIntent &&
      (parsed.kind === 'amount_update' ||
        parsed.kind === 'recipient_update' ||
        parsed.kind === 'destination_update' ||
        CLARIFICATION_RE.test(trimmed))
    ) {
      return 'clarification';
    }
    return 'action';
  }

  if (options?.hasActiveMoneyIntent && CLARIFICATION_RE.test(trimmed)) {
    return 'clarification';
  }

  if (SMALL_TALK_RE.test(trimmed) || isPureGreeting(trimmed)) {
    return 'conversation';
  }

  // Ambiguous free text → prefer conversation over a menu dump.
  return 'conversation';
}

export function isPureGreeting(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /^(hi|hey|hello|yo|yoo|hiya|good (morning|afternoon|evening)|gm|evening)[.!\s]*$/i.test(
      q
    ) ||
    /^(hi|hey|hello)\s+(there|man|bro|sis|guys?)[.!\s]*$/i.test(q)
  );
}

/** True when text is chatty and should not force a financial menu. */
export function shouldPreferConversation(
  text: string,
  options?: { hasActiveMoneyIntent?: boolean }
): boolean {
  const kind = classifyRouteKind(text, options);
  return kind === 'conversation';
}
