import { parseFlowUtterance } from './dayxFlowNlu';

export type DayxSlotIntent =
  | 'send'
  | 'top_up'
  | 'swap'
  | 'pay_bills'
  | 'balance'
  | 'other';

export type DayxExtractedSlots = {
  intent?: DayxSlotIntent;
  spendCurrency?: string;
  receiveCurrency?: string;
  method?: 'bank' | 'username' | 'crypto';
  bank_name?: string;
  recipient_raw?: string;
  amount?: number;
  bill_category?: 'airtime' | 'data' | 'electricity' | 'cable' | 'internet';
  scope?: 'local' | 'international';
  provider_hint?: string;
};

const BANK_KEYS: Record<string, string[]> = {
  opay: ['opay', 'o pay'],
  palmpay: ['palmpay', 'palm pay'],
  gtb: ['gtb', 'gt bank', 'gtbank', 'guaranty trust'],
  zenith: ['zenith'],
  access: ['access bank', 'access'],
  uba: ['uba', 'united bank for africa'],
  firstbank: ['first bank', 'firstbank', 'fbn'],
  kuda: ['kuda'],
  moniepoint: ['moniepoint'],
  sterling: ['sterling'],
  fcmb: ['fcmb'],
  wema: ['wema', 'alat'],
};

const BILL_CATEGORY_MAP: Record<string, DayxExtractedSlots['bill_category']> = {
  airtime: 'airtime',
  recharge: 'airtime',
  mtn: 'airtime',
  glo: 'airtime',
  airtel: 'airtime',
  data: 'data',
  bundle: 'data',
  electricity: 'electricity',
  meter: 'electricity',
  nep: 'electricity',
  dstv: 'cable',
  gotv: 'cable',
  cable: 'cable',
  startimes: 'cable',
  internet: 'internet',
  broadband: 'internet',
};

const CATEGORY_CODES: Record<
  NonNullable<DayxExtractedSlots['bill_category']>,
  string
> = {
  airtime: 'AIRTIME',
  data: 'MOBILEDATA',
  electricity: 'UTILITYBILLS',
  cable: 'CABLEBILLS',
  internet: 'INTERNET',
};

export function billCategoryToCode(
  cat?: DayxExtractedSlots['bill_category']
): string | undefined {
  if (!cat) return undefined;
  return CATEGORY_CODES[cat];
}

function parseAmount(q: string): number | undefined {
  const patterns = [
    /(?:₦|ngn\s*)([\d,]+(?:\.\d+)?)/i,
    /(?:\$|usd\s*)([\d,]+(?:\.\d+)?)/i,
    /([\d,]+(?:\.\d+)?)\s*(?:naira|ngn)\b/i,
    /([\d,]+(?:\.\d+)?)\s*(?:dollar|dollars|usd)\b/i,
    /\b(?:send|pay|swap|recharge|top\s*up)\s+([\d,]+(?:\.\d+)?)\b/i,
    /\b([\d,]+(?:\.\d+)?)\s*(?:k|thousand)\b/i,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m?.[1]) {
      let raw = m[1].replace(/,/g, '');
      if (/\b(k|thousand)\b/i.test(q) && !raw.includes('.')) {
        raw = String(Number(raw) * 1000);
      }
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function parseCurrency(q: string, role: 'spend' | 'receive'): string | undefined {
  const spendRe =
    /\b(from\s+)?(my\s+)?(naira|ngn|dollar|dollars|usd|euro|euros|eur|pound|pounds|gbp)\b/i;
  const swapRe =
    /\b(?:to|into)\s+(naira|ngn|dollar|dollars|usd|euro|euros|eur|pound|pounds|gbp)\b/i;
  const map: Record<string, string> = {
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
  const re = role === 'receive' ? swapRe : spendRe;
  const m = q.match(re);
  if (!m) return undefined;
  const word = (m[m.length - 1] ?? '').toLowerCase();
  return map[word];
}

/** Rule-based slot extraction (always available, no API). */
export function parseExtendedSlots(utterance: string): DayxExtractedSlots {
  const slots: DayxExtractedSlots = {};
  const q = utterance.toLowerCase().trim();
  if (!q) return slots;

  const base = parseFlowUtterance(utterance);
  if (base.flowHint === 'send') slots.intent = 'send';
  if (base.flowHint === 'swap') slots.intent = 'swap';
  if (base.flowHint === 'pay') slots.intent = 'pay_bills';
  if (base.flowHint === 'add_money') slots.intent = 'top_up';
  if (base.spendCurrency) slots.spendCurrency = base.spendCurrency;
  if (base.receiveCurrency) slots.receiveCurrency = base.receiveCurrency;
  if (base.amount != null) slots.amount = base.amount;

  if (/\b(top\s*up|add\s+money|fund|deposit|receive)\b/.test(q)) {
    slots.intent = 'top_up';
  }
  if (/\b(swap|convert|exchange)\b/.test(q)) {
    slots.intent = 'swap';
  }
  if (/\b(bill|airtime|recharge|dstv|gotv|electric|meter|cable)\b/.test(q)) {
    slots.intent = 'pay_bills';
  }
  if (/\b(send|transfer)\b/.test(q)) {
    slots.intent = 'send';
  }

  const spend = parseCurrency(q, 'spend') ?? base.spendCurrency;
  if (spend) slots.spendCurrency = spend;
  const recv = parseCurrency(q, 'receive');
  if (recv) slots.receiveCurrency = recv;

  const amt = parseAmount(utterance) ?? base.amount;
  if (amt != null) slots.amount = amt;

  const tag = utterance.match(/@([a-zA-Z0-9_.-]+)/);
  if (tag) {
    slots.method = 'username';
    slots.recipient_raw = tag[1];
  }

  if (/\b(on[- ]?chain|crypto|usdc|eurc|stellar|ethereum|erc)\b/.test(q)) {
    slots.method = 'crypto';
  } else if (
    !slots.method &&
    (/\b(bank|account\s*number|iban|wire)\b/.test(q) ||
      Object.values(BANK_KEYS).some((keys) => keys.some((k) => q.includes(k))))
  ) {
    slots.method = 'bank';
  }

  for (const [bankName, keys] of Object.entries(BANK_KEYS)) {
    if (keys.some((k) => q.includes(k))) {
      slots.method = 'bank';
      slots.bank_name = bankName;
      break;
    }
  }

  if (/\b(username|dayfi\s*tag|dayfi\s*id)\b/.test(q)) {
    slots.method = 'username';
  }

  const acct10 = utterance.match(/\b(\d{10})\b/);
  if (acct10 && slots.method === 'bank') {
    slots.recipient_raw = acct10[1];
  }

  const phone =
    utterance.match(/\b(0[789]\d{9})\b/) ??
    utterance.match(/\b(\+?234[789]\d{9})\b/);
  if (phone) {
    const digits = phone[1].replace(/\D/g, '').replace(/^234/, '0');
    if (slots.intent === 'pay_bills') {
      slots.recipient_raw = digits.startsWith('0') ? digits : `0${digits}`;
    } else if (!slots.recipient_raw && slots.method === 'bank') {
      slots.recipient_raw = phone[1].replace(/\D/g, '').slice(-10);
    }
  }

  const meter = utterance.match(/\b(?:meter|meter\s*no\.?)\s*[:#]?\s*(\d{8,13})\b/i);
  if (meter) {
    slots.bill_category = 'electricity';
    slots.recipient_raw = meter[1];
  }

  for (const [key, cat] of Object.entries(BILL_CATEGORY_MAP)) {
    if (q.includes(key)) {
      slots.bill_category = cat;
      if (['mtn', 'glo', 'airtel', 'dstv', 'gotv'].includes(key)) {
        slots.provider_hint = key;
      }
      break;
    }
  }

  if (/\binternational\b/.test(q)) slots.scope = 'international';
  else if (slots.intent === 'pay_bills') slots.scope = 'local';

  if (/\b(bank\s+transfer|wire|iban|virtual\s+account)\b/.test(q) && slots.intent === 'top_up') {
    slots.method = 'bank';
  }

  return slots;
}

export function mergeExtractedSlots(
  ...parts: Array<DayxExtractedSlots | Record<string, unknown> | undefined>
): DayxExtractedSlots {
  const out: DayxExtractedSlots = {};
  for (const part of parts) {
    if (!part) continue;
    const p = part as DayxExtractedSlots;
    if (p.intent) out.intent = p.intent;
    if (p.spendCurrency) out.spendCurrency = p.spendCurrency.toUpperCase();
    if (p.receiveCurrency) out.receiveCurrency = p.receiveCurrency.toUpperCase();
    if (p.method) out.method = p.method;
    if (p.bank_name) out.bank_name = p.bank_name.toLowerCase();
    if (p.recipient_raw) out.recipient_raw = String(p.recipient_raw).trim();
    if (p.amount != null && Number.isFinite(Number(p.amount))) {
      out.amount = Number(p.amount);
    }
    if (p.bill_category) out.bill_category = p.bill_category;
    if (p.scope) out.scope = p.scope;
    if (p.provider_hint) out.provider_hint = p.provider_hint;
  }
  return out;
}

export function slotsToSessionData(
  slots: DayxExtractedSlots,
  flow: 'send' | 'swap' | 'pay' | 'add_money'
): Record<string, unknown> {
  const d: Record<string, unknown> = {};

  if (slots.amount != null) d.amount = slots.amount;

  if (flow === 'send') {
    if (slots.spendCurrency) d.spendCurrency = slots.spendCurrency;
    if (slots.receiveCurrency) {
      d.receiveCurrency = slots.receiveCurrency;
      d.receiveCountry = currencyToCountry(slots.receiveCurrency);
    }
    if (slots.method === 'username') d.deliveryMethod = 'dayfi_tag';
    else if (slots.method) d.deliveryMethod = slots.method;
    if (slots.bank_name) d.bank_name = slots.bank_name;
    if (slots.recipient_raw) {
      d.recipient_raw = slots.recipient_raw;
      if (slots.method === 'username') d.dayfiId = slots.recipient_raw.replace(/^@/, '');
      if (slots.method === 'bank' && /^\d{10}$/.test(slots.recipient_raw)) {
        d.accountNumber = slots.recipient_raw;
      }
    }
    if (slots.method === 'bank' && slots.spendCurrency === 'NGN' && !d.receiveCountry) {
      d.receiveCountry = 'NG';
      d.receiveCurrency = 'NGN';
    }
    if (slots.method === 'crypto' && slots.spendCurrency) {
      d.receiveCurrency = slots.spendCurrency;
      d.receiveCountry = currencyToCountry(slots.spendCurrency);
    }
  }

  if (flow === 'swap') {
    if (slots.spendCurrency) d.fromCurrency = slots.spendCurrency;
    if (slots.receiveCurrency) d.toCurrency = slots.receiveCurrency;
    if (slots.amount != null) d.amount = slots.amount;
  }

  if (flow === 'add_money') {
    if (slots.spendCurrency) d.currency = slots.spendCurrency;
    if (slots.method) d.depositMethod = slots.method;
    if (slots.intent === 'top_up' && slots.spendCurrency) {
      d.currency = slots.spendCurrency;
    }
  }

  if (flow === 'pay') {
    if (slots.scope) d.scope = slots.scope;
    if (slots.bill_category) {
      d.bill_category = slots.bill_category;
      d.categoryCode = billCategoryToCode(slots.bill_category);
    }
    if (slots.recipient_raw) d.customerId = slots.recipient_raw;
    if (slots.provider_hint) d.provider_hint = slots.provider_hint;
    if (slots.spendCurrency) d.spendCurrency = slots.spendCurrency;
  }

  return d;
}

function currencyToCountry(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'NGN':
      return 'NG';
    case 'USD':
      return 'US';
    case 'GBP':
      return 'GB';
    case 'EUR':
      return 'DE';
    default:
      return 'NG';
  }
}

export function isRecipientResolved(d: Record<string, unknown>): boolean {
  const method = String(d.deliveryMethod ?? '');
  if (method === 'dayfi_tag') {
    return Boolean(d.dayfiVerified && d.dayfiId);
  }
  if (method === 'bank') {
    return Boolean(d.accountNumber && d.accountName);
  }
  if (method === 'crypto') {
    return Boolean(d.cryptoAddress && String(d.cryptoAddress).length >= 20);
  }
  return Boolean(d.recipient_resolved);
}

export function buildSlotAck(
  d: Record<string, unknown>,
  flow: 'send' | 'swap' | 'pay' | 'add_money'
): string {
  const bits: string[] = [];
  if (flow === 'send') {
    if (d.spendCurrency) bits.push(`from your ${d.spendCurrency} wallet`);
    if (d.bank_name) bits.push(`via ${String(d.bank_name)}`);
    if (d.amount) bits.push(`for ${formatAmt(d.amount, d.spendCurrency)}`);
    if (d.accountName) bits.push(`to ${d.accountName}`);
    else if (d.dayfiId) bits.push(`to @${d.dayfiId}`);
    else if (d.recipient_raw) bits.push(`to ${d.recipient_raw}`);
  }
  if (flow === 'swap') {
    if (d.fromCurrency && d.toCurrency) {
      bits.push(`${d.fromCurrency} → ${d.toCurrency}`);
    }
    if (d.amount) bits.push(formatAmt(d.amount, d.fromCurrency));
  }
  if (flow === 'add_money') {
    if (d.currency) bits.push(`your ${d.currency} wallet`);
    if (d.depositMethod) bits.push(`via ${d.depositMethod}`);
  }
  if (flow === 'pay') {
    if (d.bill_category) bits.push(String(d.bill_category));
    if (d.customerId) bits.push(`for ${d.customerId}`);
    if (d.amount) bits.push(formatAmt(d.amount, 'NGN'));
  }
  if (!bits.length) return '';
  return `Got it — ${bits.join(', ')}.`;
}

function formatAmt(amount: unknown, currency?: unknown): string {
  const n = Number(amount);
  const c = String(currency ?? 'NGN').toUpperCase();
  if (!Number.isFinite(n)) return '';
  const sym = c === 'NGN' ? '₦' : c === 'USD' ? '$' : '';
  return `${sym}${n.toLocaleString()} ${c}`.trim();
}
