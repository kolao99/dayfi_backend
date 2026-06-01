import { countryLabel } from './dayxFlowChannels';

export type DayxFlowNluSlots = {
  receiveCountry?: string;
  receiveCurrency?: string;
  spendCurrency?: string;
  recipientHint?: string;
  amount?: number;
  flowHint?: 'send' | 'swap' | 'pay' | 'add_money';
};

const COUNTRY_ALIASES: Record<string, { country: string; currency: string }> = {
  nigeria: { country: 'NG', currency: 'NGN' },
  nigerian: { country: 'NG', currency: 'NGN' },
  ghana: { country: 'GH', currency: 'GHS' },
  kenya: { country: 'KE', currency: 'KES' },
  uganda: { country: 'UG', currency: 'UGX' },
  tanzania: { country: 'TZ', currency: 'TZS' },
  rwanda: { country: 'RW', currency: 'RWF' },
  'south africa': { country: 'ZA', currency: 'ZAR' },
  zambia: { country: 'ZM', currency: 'ZMW' },
  'united states': { country: 'US', currency: 'USD' },
  usa: { country: 'US', currency: 'USD' },
  america: { country: 'US', currency: 'USD' },
  uk: { country: 'GB', currency: 'GBP' },
  britain: { country: 'GB', currency: 'GBP' },
  'united kingdom': { country: 'GB', currency: 'GBP' },
  euro: { country: 'DE', currency: 'EUR' },
  europe: { country: 'DE', currency: 'EUR' },
};

const SPEND_ALIASES: Record<string, string> = {
  naira: 'NGN',
  ngn: 'NGN',
  dollar: 'USD',
  dollars: 'USD',
  usd: 'USD',
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  pound: 'GBP',
  pounds: 'GBP',
  gbp: 'GBP',
};

export function parseFlowUtterance(utterance?: string): DayxFlowNluSlots {
  const slots: DayxFlowNluSlots = {};
  if (!utterance?.trim()) return slots;

  const q = utterance.toLowerCase();

  if (
    /\b(send|transfer|pay\s+my|pay\s+her|pay\s+him|pay\s+them)\b/.test(q)
  ) {
    slots.flowHint = 'send';
  } else if (/\b(swap|convert|exchange)\b/.test(q)) {
    slots.flowHint = 'swap';
  } else if (/\b(bill|airtime|data|electric|cable|utility|dstv|gotv)\b/.test(
    q
  )) {
    slots.flowHint = 'pay';
  } else if (/\b(top\s*up|add\s+money|fund|deposit)\b/.test(q)) {
    slots.flowHint = 'add_money';
  }

  for (const [phrase, loc] of Object.entries(COUNTRY_ALIASES)) {
    if (q.includes(phrase)) {
      slots.receiveCountry = loc.country;
      slots.receiveCurrency = loc.currency;
      break;
    }
  }

  for (const [phrase, cur] of Object.entries(SPEND_ALIASES)) {
    if (
      new RegExp(`\\b(from\\s+)?(my\\s+)?${phrase}\\b`).test(q) ||
      new RegExp(`\\b${phrase}\\s+wallet\\b`).test(q)
    ) {
      slots.spendCurrency = cur;
      break;
    }
  }

  const amountMatch = q.match(
    /(?:₦|ngn\s*)?([\d,]+(?:\.\d+)?)\s*(?:naira|ngn)?|(?:\$|usd\s*)?([\d,]+(?:\.\d+)?)\s*(?:dollar|usd)?/
  );
  if (amountMatch) {
    const raw = (amountMatch[1] ?? amountMatch[2] ?? '').replace(/,/g, '');
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) slots.amount = n;
  }

  const relMatch = q.match(
    /\b(?:my|to)\s+(sister|brother|mum|mom|mother|dad|father|friend|wife|husband|cousin)\b/
  );
  if (relMatch) {
    slots.recipientHint = relMatch[1];
  }

  return slots;
}

export function countryReply(country: string): string {
  return countryLabel(country);
}
