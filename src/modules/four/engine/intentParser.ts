/**
 * Deterministic intent parsing for Four v1.
 *
 * No LLM in the vertical slice — regex and slot rules only, so tests stay
 * predictable and money never depends on model output.
 */

import { parseBalanceCurrencyHint } from '../finance/balanceService';

export type BankTransferTarget = {
  accountNumber: string;
  bankHint: string;
  /** True when the account digit run is present but not a full 10-digit NUBAN. */
  incomplete?: boolean;
};

export type ParsedUserMessage =
  | { kind: 'balance' }
  | { kind: 'balance_in_currency'; currency: string }
  | { kind: 'send_cost_quote'; amount: number; currency: string }
  | { kind: 'kyc' }
  | {
      kind: 'send';
      amount: number | null;
      recipientName: string | null;
      bankTarget?: BankTransferTarget | null;
      raw: string;
    }
  | { kind: 'send_prompt' }
  | { kind: 'fund' }
  | { kind: 'bank_details' }
  | { kind: 'receive_help' }
  | { kind: 'tx_history' }
  | { kind: 'tx_status' }
  | {
      kind: 'unsupported_corridor';
      currency: string;
      amount: number | null;
      raw: string;
    }
  | { kind: 'amount_update'; amount: number }
  | { kind: 'recipient_update'; recipientName: string; raw: string }
  | {
      kind: 'destination_update';
      bankTarget: BankTransferTarget | null;
      recipientName: string | null;
      raw: string;
    }
  | { kind: 'cancel' }
  | { kind: 'bill_prompt' }
  | { kind: 'airtime_prompt' }
  | { kind: 'swap_unavailable' }
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

/** True when a digit run looks like an account/phone, not a transfer amount. */
export function looksLikeAccountDigits(text: string): boolean {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 11;
}

export function isBalanceQuery(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return false;
  // Valuation questions are handled separately.
  if (
    /\bin\s+(naira|ngn|cedis?|ghs|kes|zar|dollars?|usd|usdc|euros?|eur)\b/.test(
      q
    )
  ) {
    return false;
  }
  return (
    /\b(balance|how much (do i have|money|is in my wallet)|what(?:'s| is) my balance|show my (?:wallet|balance))\b/.test(
      q
    ) ||
    q === 'balance' ||
    /\bhow much (?:usdc|money) (?:do i |i )?(?:have|get)\b/.test(q) ||
    /\bwetin be my balance\b/.test(q) ||
    /\bhow much dey my wallet\b/.test(q)
  );
}

/** "Buy USDC" / "I want to buy crypto" → fiat or crypto funding, not a CEX. */
export function isBuyUsdcOrFundIntent(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\b(buy|purchase|get)\s+(?:some\s+)?(?:usdc|crypto)\b/.test(q) ||
    /\bi want to (?:buy|add|get)\s+(?:usdc|crypto)\b/.test(q) ||
    /\badd\s+₦?\s*\d/.test(q) ||
    /\bfund with (?:bank|naira|ngn|fiat)\b/.test(q)
  );
}

/** "Sell USDC" → off-ramp / send fiat, not a CEX sell. */
export function isSellUsdcIntent(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\b(sell|cash\s*out|off[- ]?ramp)\s+(?:my\s+)?(?:usdc|crypto)\b/.test(q) ||
    /\bwithdraw\s+(?:to\s+)?(?:bank|naira|ngn)\b/.test(q)
  );
}

/** True asset conversion asks — not FX valuation or fund/send. */
export function isSwapIntent(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\b(swap|convert|exchange)\b/.test(q) &&
    /\b(usdc|eurc|crypto|token|asset)\b/.test(q)
  );
}

export function parseSendCostQuote(
  text: string
): { amount: number; currency: string } | null {
  const q = text.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
  // How much USDC do I need to send ₦10,000 / 10k
  const need = q.match(
    /(?:how much(?: usdc)?(?: do i need)?(?: to)?|what(?:'s| is) the (?:usdc )?cost(?: to)?|how much will)\s*(?:send\s+)?(?:₦|ngn\s*|n\s*)?(\d+(?:\.\d+)?)\s*k?\b/
  );
  if (need) {
    let n = Number(need[1]);
    if (/k\b/.test(q.slice(need.index || 0))) n = Math.round(n * 1000);
    if (Number.isFinite(n) && n > 0) {
      return { amount: n, currency: 'NGN' };
    }
  }
  const alt = q.match(
    /(?:cost|need|quote).{0,24}(?:₦|ngn\s*)(\d+(?:\.\d+)?)\s*k?\b/
  );
  if (alt) {
    let n = Number(alt[1]);
    if (/\d+\s*k\b/.test(q)) n = Math.round(n * 1000);
    if (Number.isFinite(n) && n > 0) return { amount: n, currency: 'NGN' };
  }
  return null;
}

export function isCancelMessage(text: string): boolean {
  const q = text.toLowerCase().trim();
  return (
    q === 'cancel' ||
    q === 'stop' ||
    q === 'nah' ||
    q === 'nope' ||
    q === 'never mind' ||
    q === 'nevermind' ||
    q === 'forget it' ||
    q.startsWith('cancel ') ||
    /^(actually\s+)?no[.!]*$/.test(q)
  );
}

export function isBankDetailsRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\b(my (?:bank |ngn )?account(?: number)?|bank details|nuban|virtual account)\b/.test(
      q
    ) ||
    /\b(give me|what(?:'s| is)|show)\s+(?:my\s+)?(?:ngn\s+)?(?:account|bank)\b/.test(
      q
    ) ||
    /\bwhat(?:'s| is) my account number\b/.test(q)
  );
}

export function isReceiveHelpRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\bhow can (?:someone|people|they) send me (?:money|cash|funds)\b/.test(
      q
    ) ||
    /\bhow (?:do i|to) receive (?:money|cash|funds|usdc|ngn)\b/.test(q) ||
    /\bwhere do i receive\b/.test(q) ||
    /\bcan someone send me (?:money|ngn|ghs|usdc)\b/.test(q)
  );
}

export function isTxHistoryRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\b(show|list|see|check)\s+(?:my\s+)?(?:transactions|tx|history|payments)\b/.test(
      q
    ) ||
    /\bwhat did i (?:spend|pay|send)\b/.test(q) ||
    /\brecent (?:transactions|activity|payments)\b/.test(q) ||
    /\bwhen did i fund\b/.test(q) ||
    q === 'transactions' ||
    q === 'history'
  );
}

export function isTxStatusRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (isDepositStatusQuestionSafe(q)) return false;
  return (
    /\bdid (?:my |the )?(?:transfer|payment|send|money|₦?\d)/.test(q) ||
    /\bhas (?:he|she|they|kola) received\b/.test(q) ||
    /\bdid (?:it|that) (?:go through|work|arrive)\b/.test(q) ||
    /\bwhere(?:'s| is) my money\b/.test(q) ||
    /\bwhat happened to my (?:last )?(?:payment|transfer|send)\b/.test(q)
  );
}

function isDepositStatusQuestionSafe(q: string): boolean {
  return /\b(usdc|eurc|stellar|deposit|crypto)\b/.test(q) &&
    /\b(arriv|received|confirm|status|yet)\b/.test(q);
}

/** Non-NGN fiat send/fund that Azap cannot execute yet (YC HTTP-only). */
export function parseUnsupportedCorridor(
  text: string
): { currency: string; amount: number | null } | null {
  const q = text.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const m = q.match(
    /\b(ghs|gh₵|cedis?|kes|shillings?|zar|rand|ugx|tzs|xof|xaf|mwk|rwf|zmw|bwp|cdf)\b/
  );
  if (!m) return null;
  // Valuation-only questions are not corridor sends.
  if (/\b(balance|have|worth|equivalent|in)\b/.test(q) && !/\bsend\b/.test(q) && !/\bfund\b/.test(q)) {
    return null;
  }
  if (!/\b(send|fund|add|pay|transfer)\b/.test(q)) return null;
  const aliases: Record<string, string> = {
    ghs: 'GHS',
    'gh₵': 'GHS',
    cedi: 'GHS',
    cedis: 'GHS',
    kes: 'KES',
    shilling: 'KES',
    shillings: 'KES',
    zar: 'ZAR',
    rand: 'ZAR',
    ugx: 'UGX',
    tzs: 'TZS',
    xof: 'XOF',
    xaf: 'XAF',
    mwk: 'MWK',
    rwf: 'RWF',
    zmw: 'ZMW',
    bwp: 'BWP',
    cdf: 'CDF',
  };
  const currency = aliases[m[1]] || m[1].toUpperCase();
  const amount = parseAmount(text);
  return { currency, amount };
}

export function isKycRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (q === '/kyc' || q === 'kyc') return true;
  return (
    /\b(kyc|verify(?: my)?(?: bvn| identity| account)?|complete(?: my)? verification|verify my bvn)\b/.test(
      q
    ) ||
    q.includes('help me with kyc') ||
    q.includes('how do i verify my bvn') ||
    q.includes('how do i complete verification')
  );
}

export function isFundRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    q === 'fund' ||
    q === 'fund wallet' ||
    q === 'fund my wallet' ||
    q === 'add money' ||
    q === 'deposit' ||
    q === 'top up' ||
    q === 'top up wallet' ||
    q === 'i want to fund my wallet' ||
    /^how (?:do i|to|can i) (?:fund|add money)/.test(q) ||
    /^fund my wallet/.test(q) ||
    /\bhow (?:can|do) i add money\b/.test(q) ||
    /\bput\s+\d/.test(q) ||
    /\bi want to add money\b/.test(q)
  );
}

export function isSendPrompt(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    q === 'send money' ||
    q === 'i want to send money' ||
    q === 'i want to send cash' ||
    q === 'i want to send funds' ||
    /^i want to send money\.?$/.test(q) ||
    q === 'money to kola' ||
    /^send\s+money\.?$/.test(q)
  );
}

export function isAirtimeRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return false;
  return (
    /\b(buy airtime|buy data|airtime|data bundle|top ?up (?:my )?(?:airtime|data|number))\b/.test(
      q
    ) ||
    /\b(i need (?:airtime|data)|get (?:me )?data|buy me (?:\d+\s*)?(?:gb\s+)?data)\b/.test(
      q
    ) ||
    q === 'buy airtime' ||
    q === 'airtime' ||
    q === 'buy data' ||
    q === 'data'
  );
}

export function isBillRequest(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return false;
  return (
    /\b(pay(?:\s+a|\s+my)?\s+bill|bill payment|can i pay (?:a )?bill|i (?:want|need|should be able) to pay (?:a )?bill)\b/.test(
      q
    ) ||
    /\bpay (?:my )?(?:electricity|internet|dstv|gotv|cable|tv|utility|light|nepa|phcn|wifi|wi-?fi)\b/.test(
      q
    ) ||
    /\brenew (?:my )?(?:dstv|gotv|cable|internet|wifi)\b/.test(q) ||
    q === 'pay a bill' ||
    q === 'bills'
  );
}

function cleanRecipientName(name: string): string {
  return name
    .replace(/[.?!,'"]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bankHintFromRemainder(trimmed: string, accountNumber: string): string {
  return trimmed
    .replace(accountNumber, '')
    .replace(/[,'"]/g, ' ')
    // "Send to OPay 813…" → remainder may still include a stray "to"
    .replace(/\bto\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse "OPay 8131208415", incomplete "OPay 813120841", or a saved name. */
export function parseDestinationPart(dest: string): {
  recipientName: string | null;
  bankTarget: BankTransferTarget | null;
} {
  const trimmed = dest.trim();
  const fullMatch = trimmed.match(/\b(\d{10})\b/);
  if (fullMatch) {
    const accountNumber = fullMatch[1];
    return {
      recipientName: null,
      bankTarget: {
        accountNumber,
        bankHint: bankHintFromRemainder(trimmed, accountNumber),
      },
    };
  }

  const partialMatch = trimmed.match(/\b(\d{7,9})\b/);
  if (partialMatch) {
    const accountNumber = partialMatch[1];
    const bankHint = bankHintFromRemainder(trimmed, accountNumber);
    // Bank hint + short digit run → incomplete NUBAN, never a contact nickname.
    if (bankHint) {
      return {
        recipientName: null,
        bankTarget: {
          accountNumber,
          bankHint,
          incomplete: true,
        },
      };
    }
  }

  return { recipientName: cleanRecipientName(trimmed), bankTarget: null };
}

/** Extract a NGN account + bank hint from a send phrase (10-digit preferred). */
export function parseBankTransferTarget(text: string): BankTransferTarget | null {
  const trimmed = text.trim();
  const dest = parseDestinationPart(
    trimmed
      .replace(/^send\s+/i, '')
      .replace(/\b(?:₦|ngn)?\s*\d+(?:\.\d+)?\s*k?\b/gi, ' ')
      .replace(/\bto\b/gi, ' ')
      .replace(/[,.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  return dest.bankTarget;
}

export function parseSendMessage(text: string): {
  amount: number | null;
  recipientName: string | null;
  bankTarget?: BankTransferTarget | null;
} {
  const trimmed = text.trim();

  const sendTo = trimmed.match(/^send\s+(.+?)\s+to\s+(.+)$/i);
  if (sendTo) {
    const amount = parseAmount(sendTo[1]);
    const dest = parseDestinationPart(sendTo[2]);
    if (dest.bankTarget) {
      return { amount, recipientName: null, bankTarget: dest.bankTarget };
    }
    return { amount, recipientName: dest.recipientName };
  }

  // "Send to OPay 813120841" / "Send to Kola" — destination only (no amount before "to")
  const sendToOnly = trimmed.match(/^send\s+to\s+(.+)$/i);
  if (sendToOnly) {
    const dest = parseDestinationPart(sendToOnly[1]);
    if (dest.bankTarget) {
      return { amount: null, recipientName: null, bankTarget: dest.bankTarget };
    }
    if (dest.recipientName) {
      return { amount: null, recipientName: dest.recipientName };
    }
  }

  // Teen pattern: "Send Kola 5k" / "Send Kola ₦5,000" (name then amount, no "to")
  const nameThenAmount = trimmed.match(
    /^send\s+([a-z][a-z0-9 .'-]{0,40}?)\s+((?:₦|ngn\s*)?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*k?|(?:₦|ngn\s*)?\d+(?:\.\d+)?\s*k?)\s*$/i
  );
  if (nameThenAmount) {
    const namePart = nameThenAmount[1].trim();
    const amountRaw = nameThenAmount[2].trim();
    const amountDigits = amountRaw.replace(/\D/g, '');
    // Don't steal bank destinations: "Send to OPay 813120841" or "Send OPay 8131208415"
    const amountLooksLikeAccount =
      /^\d{7,10}$/.test(amountDigits) && !/[₦k]|ngn|,/i.test(amountRaw);
    if (
      !/^to\b/i.test(namePart) &&
      !amountLooksLikeAccount &&
      !/\d{7,}/.test(namePart) &&
      !isLikelyBankNameOnlyForSend(namePart)
    ) {
      const amount = parseAmount(amountRaw);
      const dest = parseDestinationPart(namePart);
      if (!dest.bankTarget && dest.recipientName && amount != null) {
        return { amount, recipientName: dest.recipientName };
      }
    }
  }

  const sendOnly = trimmed.match(/^send\s+(.+)$/i);
  if (sendOnly) {
    const part = sendOnly[1].trim();
    const innerTo = part.match(/^(.+?)\s+to\s+(.+)$/i);
    if (innerTo) {
      const amount = parseAmount(innerTo[1]);
      const dest = parseDestinationPart(innerTo[2]);
      if (dest.bankTarget) {
        return { amount, recipientName: null, bankTarget: dest.bankTarget };
      }
      return { amount, recipientName: dest.recipientName };
    }

    // "Send OPay 8131208415" — bank destination, not an amount
    const destOnly = parseDestinationPart(part);
    if (destOnly.bankTarget) {
      return {
        amount: null,
        recipientName: null,
        bankTarget: destOnly.bankTarget,
      };
    }

    return { amount: parseAmount(part), recipientName: null };
  }

  const bankTarget = parseBankTransferTarget(trimmed);
  return { amount: null, recipientName: null, bankTarget: bankTarget ?? null };
}

function isLikelyBankNameOnlyForSend(name: string): boolean {
  // "Send OPay 5k" is ambiguous; prefer amount-only if it's clearly a bank brand alone.
  return /^(opay|palmpay|kuda|gtb|gtbank|access|uba|zenith|firstbank|fcmb|sterling)$/i.test(
    name.trim()
  );
}

export function parseRecipientUpdate(text: string): string | null {
  const trimmed = text.trim();
  const patterns = [
    /^actually send(?: it)? to (.+)$/i,
    /^change (?:the )?recipient to (.+)$/i,
    /^send it to (.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return cleanRecipientName(match[1]);
  }
  return null;
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

  const sendCost = parseSendCostQuote(trimmed);
  if (sendCost) {
    return {
      kind: 'send_cost_quote',
      amount: sendCost.amount,
      currency: sendCost.currency,
    };
  }

  // Valuation before generic balance so "balance in naira" keeps the currency.
  const valuationCcy = parseBalanceCurrencyHint(trimmed);
  if (valuationCcy) {
    return { kind: 'balance_in_currency', currency: valuationCcy };
  }

  if (isBalanceQuery(trimmed)) return { kind: 'balance' };
  if (isKycRequest(trimmed)) return { kind: 'kyc' };
  if (isBankDetailsRequest(trimmed)) return { kind: 'bank_details' };
  if (isReceiveHelpRequest(trimmed)) return { kind: 'receive_help' };
  if (isTxHistoryRequest(trimmed)) return { kind: 'tx_history' };
  if (isTxStatusRequest(trimmed)) return { kind: 'tx_status' };
  if (isBillRequest(trimmed)) return { kind: 'bill_prompt' };
  if (isAirtimeRequest(trimmed)) return { kind: 'airtime_prompt' };
  if (isSwapIntent(trimmed)) return { kind: 'swap_unavailable' };
  if (isSellUsdcIntent(trimmed)) return { kind: 'send_prompt' };

  const unsupported = parseUnsupportedCorridor(trimmed);
  if (unsupported) {
    return {
      kind: 'unsupported_corridor',
      currency: unsupported.currency,
      amount: unsupported.amount,
      raw: trimmed,
    };
  }

  if (isBuyUsdcOrFundIntent(trimmed) || isFundRequest(trimmed)) {
    return { kind: 'fund' };
  }
  if (isSendPrompt(trimmed)) return { kind: 'send_prompt' };

  const recipientUpdate = parseRecipientUpdate(trimmed);
  if (recipientUpdate) {
    return {
      kind: 'recipient_update',
      recipientName: recipientUpdate,
      raw: trimmed,
    };
  }

  const amountUpdate = parseAmountUpdate(trimmed);
  if (amountUpdate != null && /make it|change|update|actually/i.test(trimmed)) {
    return { kind: 'amount_update', amount: amountUpdate };
  }

  if (/^send\b/i.test(trimmed)) {
    const parsed = parseSendMessage(trimmed);
    return {
      kind: 'send',
      amount: parsed.amount,
      recipientName: parsed.recipientName,
      bankTarget: parsed.bankTarget,
      raw: trimmed,
    };
  }

  // Follow-up destination: "OPay 8131208415" / incomplete "OPay 813120841"
  // Must win over greedy amount parsing (which would treat digits as ₦8131208415).
  const destOnly = parseDestinationPart(trimmed);
  if (destOnly.bankTarget) {
    return {
      kind: 'destination_update',
      bankTarget: destOnly.bankTarget,
      recipientName: null,
      raw: trimmed,
    };
  }

  const loneAmount = parseAmount(trimmed);
  if (loneAmount != null) {
    const isExplicitMoney =
      /₦|\bngn\b|\bk\b/i.test(trimmed) || /^\d{1,6}(?:\.\d+)?$/.test(trimmed);
    if (isExplicitMoney || !looksLikeAccountDigits(trimmed)) {
      return { kind: 'amount_update', amount: loneAmount };
    }
  }

  return { kind: 'unknown', raw: trimmed };
}

export function isLikelyBankName(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q || q.length > 40) return false;
  if (/\d{7,}/.test(q)) return false;
  return /^[a-z0-9][a-z0-9\s'.-]{1,38}$/i.test(q);
}
