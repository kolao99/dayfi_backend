/**
 * Deterministic intent parsing for Four v1.
 *
 * No LLM in the vertical slice — regex and slot rules only, so tests stay
 * predictable and money never depends on model output.
 */

export type ParsedUserMessage =
  | { kind: 'balance' }
  | { kind: 'send'; amount: number | null; recipientName: string | null; raw: string }
  | { kind: 'amount_update'; amount: number }
  | { kind: 'cancel' }
  | { kind: 'unknown'; raw: string };

export function parseAmount(text: string): number | null {
  const normalized = text.replace(/,/g, '').trim();
  const naira = normalized.match(/(?:₦|ngn\s*)?(\d+(?:\.\d+)?)\s*k\b/i);
  if (naira) {
    const n = Number(naira[1]);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }

  const plain = normalized.match(/(?:₦|ngn\s*)?(\d+(?:\.\d+)?)/i);
  if (plain) {
    const n = Number(plain[1]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  return null;
}

export function isBalanceQuery(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return false;
  return (
    /\b(balance|how much (do i have|money|is in my wallet)|what(?:'s| is) my balance)\b/.test(
      q
    ) || q === 'balance'
  );
}

export function isCancelMessage(text: string): boolean {
  const q = text.toLowerCase().trim();
  return q === 'cancel' || q === 'stop' || q.startsWith('cancel ');
}

export function parseSendMessage(text: string): {
  amount: number | null;
  recipientName: string | null;
} {
  const trimmed = text.trim();

  let amount: number | null = null;
  let recipientName: string | null = null;

  const sendTo = trimmed.match(/^send\s+(.+?)\s+to\s+(.+)$/i);
  if (sendTo) {
    amount = parseAmount(sendTo[1]);
    recipientName = cleanRecipientName(sendTo[2]);
    return { amount, recipientName };
  }

  const sendOnly = trimmed.match(/^send\s+(.+)$/i);
  if (sendOnly) {
    const part = sendOnly[1].trim();
    const innerTo = part.match(/^(.+?)\s+to\s+(.+)$/i);
    if (innerTo) {
      amount = parseAmount(innerTo[1]);
      recipientName = cleanRecipientName(innerTo[2]);
    } else {
      amount = parseAmount(part);
    }
    return { amount, recipientName };
  }

  const toOnly = trimmed.match(/^(.+?)\s+to\s+(.+)$/i);
  if (toOnly) {
    amount = parseAmount(toOnly[1]);
    recipientName = cleanRecipientName(toOnly[2]);
  }

  return { amount, recipientName };
}

function cleanRecipientName(name: string): string {
  return name
    .replace(/[.?!,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAmountUpdate(text: string): number | null {
  const q = text.toLowerCase().trim();
  if (
    /^(make it|change (it )?to|update to|actually)\s+/i.test(q) ||
    /^\d/.test(q)
  ) {
    return parseAmount(text);
  }
  return null;
}

export function parseUserMessage(text: string): ParsedUserMessage {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'unknown', raw: '' };

  if (isCancelMessage(trimmed)) return { kind: 'cancel' };
  if (isBalanceQuery(trimmed)) return { kind: 'balance' };

  const amountUpdate = parseAmountUpdate(trimmed);
  if (amountUpdate != null && /make it|change|update|actually/i.test(trimmed)) {
    return { kind: 'amount_update', amount: amountUpdate };
  }

  if (/^send\b/i.test(trimmed) || /\bto\s+\w/i.test(trimmed)) {
    const parsed = parseSendMessage(trimmed);
    return {
      kind: 'send',
      amount: parsed.amount,
      recipientName: parsed.recipientName,
      raw: trimmed,
    };
  }

  const loneAmount = parseAmount(trimmed);
  if (loneAmount != null) {
    return { kind: 'amount_update', amount: loneAmount };
  }

  return { kind: 'unknown', raw: trimmed };
}
