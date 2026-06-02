import { chatJsonCompletion, isDayxAiConfigured } from './dayxAiJson';
import type { DayxExtractedSlots } from './dayxFlowSlots';
import {
  mergeExtractedSlots,
  parseExtendedSlots,
} from './dayxFlowSlots';

const SLOT_EXTRACTION_PROMPT = `You are a slot extractor for a fintech app. Given a user utterance, extract all financial transaction slots you can infer. Be liberal — if the user says "opay" that implies bank transfer method AND bank_name=opay. If they give a 10-digit number that looks like a Nigerian phone/account, store it as recipient_raw. If they say "naira" or "NGN" or "my naira wallet", that is spendCurrency=NGN.

Never set "amount" from a bare 10-digit Nigerian account or phone number — that belongs in recipient_raw only.

If the user says total/all/full/entire/max balance, everything in a wallet, or "swap all USD", set amountMode to "max" and leave amount null unless they also give an explicit number.

Return ONLY valid JSON, no prose, no markdown:
{
  "intent": "send | top_up | swap | pay_bills | balance | other",
  "spendCurrency": "NGN | USD | EUR | GBP | null",
  "receiveCurrency": "NGN | USD | EUR | GBP | null",
  "method": "bank | username | crypto | null",
  "bank_name": "opay | palmpay | gtb | zenith | ... | null",
  "recipient_raw": "account number, username @..., or address | null",
  "amount": number | null,
  "amountMode": "max | null",
  "bill_category": "airtime | data | electricity | cable | internet | null",
  "scope": "local | international | null",
  "provider_hint": "mtn | glo | dstv | null"
}`;

function groqSlotsToExtracted(raw: Record<string, unknown>): DayxExtractedSlots {
  const slots: DayxExtractedSlots = {};
  const intent = String(raw.intent ?? '').toLowerCase();
  if (
    intent === 'send' ||
    intent === 'top_up' ||
    intent === 'swap' ||
    intent === 'pay_bills' ||
    intent === 'balance' ||
    intent === 'other'
  ) {
    slots.intent = intent as DayxExtractedSlots['intent'];
  }

  const cur = (v: unknown) => {
    const s = String(v ?? '').toUpperCase();
    if (['NGN', 'USD', 'EUR', 'GBP'].includes(s)) return s;
    return undefined;
  };

  slots.spendCurrency = cur(raw.spendCurrency);
  slots.receiveCurrency = cur(raw.receiveCurrency);

  const method = String(raw.method ?? '').toLowerCase();
  if (method === 'bank' || method === 'username' || method === 'crypto') {
    slots.method = method;
  }

  const bank = raw.bank_name;
  if (bank && String(bank).toLowerCase() !== 'null') {
    slots.bank_name = String(bank).toLowerCase();
  }

  const recip = raw.recipient_raw;
  if (recip && String(recip).toLowerCase() !== 'null') {
    slots.recipient_raw = String(recip).replace(/^@/, '').trim();
  }

  const amt = raw.amount;
  if (amt != null && Number.isFinite(Number(amt)) && Number(amt) > 0) {
    slots.amount = Number(amt);
  }

  const mode = String(raw.amountMode ?? '').toLowerCase();
  if (mode === 'max') {
    slots.amountMode = 'max';
  }

  const cat = String(raw.bill_category ?? '').toLowerCase();
  if (
    cat === 'airtime' ||
    cat === 'data' ||
    cat === 'electricity' ||
    cat === 'cable' ||
    cat === 'internet'
  ) {
    slots.bill_category = cat;
  }

  const scope = String(raw.scope ?? '').toLowerCase();
  if (scope === 'local' || scope === 'international') {
    slots.scope = scope;
  }

  const hint = raw.provider_hint;
  if (hint && String(hint).toLowerCase() !== 'null') {
    slots.provider_hint = String(hint).toLowerCase();
  }

  return slots;
}

/** Groq + rules merged; rules win on conflict for safety on amounts. */
export async function extractFlowSlots(
  utterance?: string
): Promise<DayxExtractedSlots> {
  const text = utterance?.trim();
  if (!text) return {};

  const rules = parseExtendedSlots(text);

  if (!isDayxAiConfigured()) {
    return rules;
  }

  try {
    const raw = await chatJsonCompletion({
      system: SLOT_EXTRACTION_PROMPT,
      user: text,
      maxTokens: 350,
    });
    const groq = groqSlotsToExtracted(raw);
    return mergeExtractedSlots(rules, groq);
  } catch {
    return rules;
  }
}
