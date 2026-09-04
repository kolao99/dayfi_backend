/**
 * Azap bill payments — conversational adapter over consumer BillsService
 * (same path SendHome uses: Flutterwave VAS → Dayfi ledger).
 *
 * Categories (SendHome presets):
 *   AIRTIME | MOBILEDATA | UTILITYBILLS | INTSERVICE | CABLEBILLS
 */
import { billsService } from '../../payment/billsService';
import { upsertActiveIntent } from '../intent/intentService';
import { hasSufficientBalanceForSend } from './balanceService';
import { formatMoney } from '../../payment/walletModel';
import { parseAmount } from '../engine/intentParser';

export type BillCategoryCode =
  | 'AIRTIME'
  | 'MOBILEDATA'
  | 'UTILITYBILLS'
  | 'INTSERVICE'
  | 'CABLEBILLS';

type BillReply = {
  role: 'assistant';
  type: 'text' | 'review' | 'choice';
  content: string;
  metadata?: Record<string, unknown>;
};

type BillSlots = {
  categoryCode?: BillCategoryCode;
  billerCode?: string;
  billerName?: string;
  itemCode?: string;
  itemName?: string;
  customerId?: string;
  amount?: number;
  awaiting?: string;
};

const CATEGORY_ALIASES: Array<{ code: BillCategoryCode; re: RegExp; label: string }> = [
  { code: 'AIRTIME', re: /\b(airtime|recharge|top\s*up|credit)\b/i, label: 'Airtime' },
  { code: 'MOBILEDATA', re: /\b(data|data\s*bundle|gig|gb)\b/i, label: 'Mobile data' },
  {
    code: 'UTILITYBILLS',
    re: /\b(electricity|nepa|phcn|light|power|ikedc|ekedc|aedc|phed)\b/i,
    label: 'Electricity',
  },
  {
    code: 'CABLEBILLS',
    re: /\b(dstv|gotv|startimes|showmax|cable|decoder|tv)\b/i,
    label: 'TV / cable',
  },
  {
    code: 'INTSERVICE',
    re: /\b(internet|broadband|wifi|wi-?fi|spectranet)\b/i,
    label: 'Internet',
  },
];

/** Flutterwave airtime defaults used by SendHome when catalog is thin. */
const AIRTIME_DEFAULT = { billerCode: 'BIL099', itemCode: 'AT099', billerName: 'Airtime' };

const NETWORK_HINTS: Array<{ re: RegExp; name: string }> = [
  { re: /\bmtn\b/i, name: 'MTN' },
  { re: /\bglo\b/i, name: 'Glo' },
  { re: /\bairtel\b/i, name: 'Airtel' },
  { re: /\b(9mobile|t2mobile|etisalat)\b/i, name: 'T2mobile' },
];

export function detectBillCategory(text: string): BillCategoryCode | null {
  const q = String(text || '');
  for (const row of CATEGORY_ALIASES) {
    if (row.re.test(q)) return row.code;
  }
  if (/\b(pay(?:\s+a|\s+my)?\s+bill|bill payment|can i pay)\b/i.test(q)) {
    return null; // ask which bill
  }
  return null;
}

export function categoryLabel(code: BillCategoryCode): string {
  return CATEGORY_ALIASES.find((c) => c.code === code)?.label || code;
}

function extractPhone(text: string): string | null {
  const digits = String(text || '').replace(/\D/g, '');
  if (/^0[789]\d{9}$/.test(digits)) return digits;
  if (/^234[789]\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^[789]\d{9}$/.test(digits)) return `0${digits}`;
  return null;
}

function extractMeterOrId(text: string): string | null {
  const m = String(text || '').match(/\b(\d{8,15})\b/);
  return m?.[1] || null;
}

async function resolveAirtimeBiller(
  networkHint: string | null
): Promise<{ billerCode: string; billerName: string; itemCode: string }> {
  try {
    const billers = (await billsService.getBillers('AIRTIME')) as Array<{
      biller_code?: string;
      name?: string;
      biller_name?: string;
    }>;
    if (Array.isArray(billers) && billers.length) {
      const want = (networkHint || '').toLowerCase();
      const match =
        (want
          ? billers.find((b) =>
              String(b.name || b.biller_name || '')
                .toLowerCase()
                .includes(want)
            )
          : null) || billers[0];
      const code = String(match.biller_code || AIRTIME_DEFAULT.billerCode);
      const name = String(match.name || match.biller_name || AIRTIME_DEFAULT.billerName);
      let itemCode = AIRTIME_DEFAULT.itemCode;
      try {
        const items = (await billsService.getItems(code)) as Array<{
          item_code?: string;
          biller_name?: string;
        }>;
        if (items?.[0]?.item_code) itemCode = String(items[0].item_code);
      } catch {
        /* use default */
      }
      return { billerCode: code, billerName: name, itemCode };
    }
  } catch {
    /* fall through to SendHome defaults */
  }
  return {
    billerCode: AIRTIME_DEFAULT.billerCode,
    billerName: networkHint || AIRTIME_DEFAULT.billerName,
    itemCode: AIRTIME_DEFAULT.itemCode,
  };
}

export async function beginBillPayment(input: {
  userId: string;
  conversationId: string;
  categoryCode?: BillCategoryCode | null;
  text?: string;
}): Promise<BillReply> {
  const category =
    input.categoryCode ||
    (input.text ? detectBillCategory(input.text) : null) ||
    null;

  if (!category) {
    await upsertActiveIntent({
      userId: input.userId,
      conversationId: input.conversationId,
      intent: 'PAY_BILL',
      status: 'COLLECTING_INFORMATION',
      slots: { awaiting: 'category' },
    });
    return {
      role: 'assistant',
      type: 'text',
      content:
        'Which bill would you like to pay?\n\n' +
        '• Airtime\n' +
        '• Data\n' +
        '• Electricity\n' +
        '• Internet\n' +
        '• DSTV / GOtv',
    };
  }

  const slots: BillSlots = { categoryCode: category };
  if (input.text) {
    const amount = parseAmount(input.text);
    if (amount) slots.amount = amount;
    const phone = extractPhone(input.text);
    if (phone) slots.customerId = phone;
    for (const n of NETWORK_HINTS) {
      if (n.re.test(input.text)) {
        slots.billerName = n.name;
        break;
      }
    }
  }

  return continueBillPayment({
    userId: input.userId,
    conversationId: input.conversationId,
    text: input.text || '',
    slots,
  });
}

export async function continueBillPayment(input: {
  userId: string;
  conversationId: string;
  text: string;
  slots?: Record<string, unknown>;
}): Promise<BillReply & { intentId?: string }> {
  const slots: BillSlots = {
    ...(input.slots as BillSlots),
  };
  const text = String(input.text || '').trim();

  // Category follow-up
  if (!slots.categoryCode) {
    const detected = detectBillCategory(text) || detectCategoryFromChoice(text);
    if (!detected) {
      await persist(input, { ...slots, awaiting: 'category' });
      return {
        role: 'assistant',
        type: 'text',
        content:
          'Please choose a bill type: Airtime, Data, Electricity, Internet, or DSTV/GOtv.',
      };
    }
    slots.categoryCode = detected;
  }

  const category = slots.categoryCode;

  if (text) {
    const amount = parseAmount(text);
    if (amount && amount > 0 && amount < 5_000_000) slots.amount = amount;
    const phone = extractPhone(text);
    if (phone) slots.customerId = phone;
    else if (
      category !== 'AIRTIME' &&
      category !== 'MOBILEDATA' &&
      !slots.customerId
    ) {
      const id = extractMeterOrId(text);
      if (id) slots.customerId = id;
    }
    for (const n of NETWORK_HINTS) {
      if (n.re.test(text)) {
        slots.billerName = n.name;
        break;
      }
    }
    // Named providers for electricity / TV
    if (/\bikedc\b/i.test(text)) slots.billerName = 'IKEDC';
    if (/\bekedc\b/i.test(text)) slots.billerName = 'EKEDC';
    if (/\baedc\b/i.test(text)) slots.billerName = 'AEDC';
    if (/\bphed\b/i.test(text)) slots.billerName = 'PHED';
    if (/\bdstv\b/i.test(text)) slots.billerName = 'DSTV';
    if (/\bgotv\b/i.test(text)) slots.billerName = 'GOtv';
  }

  if (category === 'AIRTIME' || category === 'MOBILEDATA') {
    if (!slots.amount) {
      await persist(input, { ...slots, awaiting: 'amount' });
      return {
        role: 'assistant',
        type: 'text',
        content: `How much ${categoryLabel(category).toLowerCase()} would you like? For example: ₦1,000`,
      };
    }
    if (!slots.customerId) {
      await persist(input, { ...slots, awaiting: 'customerId' });
      return {
        role: 'assistant',
        type: 'text',
        content: 'Which phone number should I top up? (e.g. 08012345678)',
      };
    }

    const resolved = await resolveAirtimeBiller(slots.billerName || null);
    if (category === 'MOBILEDATA') {
      // Prefer live data billers when available
      try {
        const billers = (await billsService.getBillers('MOBILEDATA')) as Array<{
          biller_code?: string;
          name?: string;
        }>;
        const want = (slots.billerName || '').toLowerCase();
        const match =
          (want
            ? billers.find((b) =>
                String(b.name || '')
                  .toLowerCase()
                  .includes(want)
              )
            : null) || billers[0];
        if (match?.biller_code) {
          resolved.billerCode = String(match.biller_code);
          resolved.billerName = String(match.name || slots.billerName || 'Data');
          const items = (await billsService.getItems(resolved.billerCode)) as Array<{
            item_code?: string;
            amount?: number | string;
            name?: string;
          }>;
          const byAmount = items.find(
            (i) => Number(i.amount) === Number(slots.amount)
          );
          const pick = byAmount || items[0];
          if (pick?.item_code) {
            resolved.itemCode = String(pick.item_code);
            slots.itemName = String(pick.name || '');
            if (byAmount) slots.amount = Number(pick.amount);
          }
        }
      } catch {
        /* keep airtime-style defaults only if data catalog fails */
      }
    }

    slots.billerCode = resolved.billerCode;
    slots.billerName = resolved.billerName;
    slots.itemCode = resolved.itemCode;
    return finalizeBillReview(input, slots);
  }

  // Electricity / internet / TV — need provider + customer id + amount
  if (!slots.billerCode && !slots.billerName) {
    await persist(input, { ...slots, awaiting: 'biller' });
    const providers = await listProviderHints(category);
    return {
      role: 'assistant',
      type: 'text',
      content:
        `Which ${categoryLabel(category)} provider?\n\n` +
        providers.map((p) => `• ${p}`).join('\n'),
    };
  }

  if (!slots.billerCode && slots.billerName) {
    const resolved = await resolveNamedBiller(category, slots.billerName);
    if (!resolved) {
      await persist(input, { ...slots, awaiting: 'biller' });
      return {
        role: 'assistant',
        type: 'text',
        content: `I couldn't find provider "${slots.billerName}". Please pick one from the list.`,
      };
    }
    slots.billerCode = resolved.billerCode;
    slots.billerName = resolved.billerName;
  }

  if (!slots.customerId) {
    await persist(input, { ...slots, awaiting: 'customerId' });
    const hint =
      category === 'UTILITYBILLS'
        ? 'meter number'
        : category === 'CABLEBILLS'
          ? 'smartcard / IUC number'
          : 'account / customer ID';
    return {
      role: 'assistant',
      type: 'text',
      content: `What's your ${hint}?`,
    };
  }

  if (!slots.amount) {
    await persist(input, { ...slots, awaiting: 'amount' });
    return {
      role: 'assistant',
      type: 'text',
      content: 'How much would you like to pay?',
    };
  }

  // Validate non-airtime/data against Flutterwave when possible
  try {
    const items = (await billsService.getItems(String(slots.billerCode))) as Array<{
      item_code?: string;
      amount?: number | string;
      name?: string;
    }>;
    const pick =
      items.find((i) => Number(i.amount) === Number(slots.amount)) || items[0];
    if (pick?.item_code) {
      slots.itemCode = String(pick.item_code);
      slots.itemName = String(pick.name || '');
    }
  } catch {
    slots.itemCode = slots.itemCode || 'default';
  }

  if (!slots.itemCode) {
    await persist(input, { ...slots, awaiting: 'item' });
    return {
      role: 'assistant',
      type: 'text',
      content:
        "I couldn't load packages for that provider right now. Please try again in a moment.",
    };
  }

  try {
    await billsService.validateBill({
      categoryCode: category,
      billerCode: String(slots.billerCode),
      itemCode: String(slots.itemCode),
      customerId: String(slots.customerId),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Validation failed';
    await persist(input, { ...slots, awaiting: 'customerId' });
    return {
      role: 'assistant',
      type: 'text',
      content: `I couldn't validate that account: ${msg}. Please check the number and try again.`,
    };
  }

  return finalizeBillReview(input, slots);
}

async function listProviderHints(category: BillCategoryCode): Promise<string[]> {
  try {
    const billers = (await billsService.getBillers(category)) as Array<{
      name?: string;
      biller_name?: string;
    }>;
    const names = billers
      .map((b) => String(b.name || b.biller_name || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    if (names.length) return names;
  } catch {
    /* presets */
  }
  if (category === 'UTILITYBILLS') return ['IKEDC', 'EKEDC', 'AEDC', 'PHED'];
  if (category === 'CABLEBILLS') return ['DSTV', 'GOtv', 'Startimes'];
  if (category === 'INTSERVICE') return ['Spectranet', 'Smile'];
  return ['MTN', 'Airtel', 'Glo', 'T2mobile'];
}

async function resolveNamedBiller(
  category: BillCategoryCode,
  name: string
): Promise<{ billerCode: string; billerName: string } | null> {
  const want = name.toLowerCase();
  try {
    const billers = (await billsService.getBillers(category)) as Array<{
      biller_code?: string;
      name?: string;
      biller_name?: string;
    }>;
    const match = billers.find((b) =>
      String(b.name || b.biller_name || '')
        .toLowerCase()
        .includes(want)
    );
    if (match?.biller_code) {
      return {
        billerCode: String(match.biller_code),
        billerName: String(match.name || match.biller_name || name),
      };
    }
  } catch {
    /* fall through */
  }
  // SendHome Flutterwave preview codes for common names
  const presets: Record<string, { code: string; name: string }> = {
    ikedc: { code: 'BIL113', name: 'IKEDC' },
    ekedc: { code: 'BIL110', name: 'EKEDC' },
    aedc: { code: 'BIL114', name: 'AEDC' },
    phed: { code: 'BIL115', name: 'PHED' },
    dstv: { code: 'BIL119', name: 'DSTV' },
    gotv: { code: 'BIL120', name: 'GOtv' },
    startimes: { code: 'BIL123', name: 'Startimes' },
  };
  const p = presets[want];
  return p ? { billerCode: p.code, billerName: p.name } : null;
}

function detectCategoryFromChoice(text: string): BillCategoryCode | null {
  const q = text.toLowerCase().trim();
  if (q === 'airtime' || q === '1') return 'AIRTIME';
  if (q === 'data' || q === '2') return 'MOBILEDATA';
  if (q === 'electricity' || q === 'light' || q === '3') return 'UTILITYBILLS';
  if (q === 'internet' || q === '4') return 'INTSERVICE';
  if (q === 'dstv' || q === 'gotv' || q === 'tv' || q === '5') return 'CABLEBILLS';
  return null;
}

async function persist(
  input: { userId: string; conversationId: string },
  slots: BillSlots
) {
  await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'PAY_BILL',
    status: 'COLLECTING_INFORMATION',
    slots: slots as Record<string, unknown>,
  });
}

async function finalizeBillReview(
  input: { userId: string; conversationId: string },
  slots: BillSlots
): Promise<BillReply & { intentId?: string }> {
  const amount = Number(slots.amount);
  const sufficient = await hasSufficientBalanceForSend(input.userId, amount, 0);
  if (!sufficient) {
    await persist(input, slots);
    return {
      role: 'assistant',
      type: 'text',
      content:
        `You don't have enough balance to pay ${formatMoney(amount, 'NGN')}.\n\n` +
        `Fund your wallet first, then try again.`,
    };
  }

  const intent = await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'PAY_BILL',
    status: 'AWAITING_CONFIRMATION',
    slots: {
      categoryCode: slots.categoryCode,
      billerCode: slots.billerCode,
      billerName: slots.billerName,
      itemCode: slots.itemCode,
      itemName: slots.itemName,
      customerId: slots.customerId,
      amount,
      currency: 'NGN',
    },
  });

  const label = categoryLabel(slots.categoryCode!);
  return {
    role: 'assistant',
    type: 'review',
    content:
      `*${label} payment*\n\n` +
      `Provider: ${slots.billerName || slots.billerCode}\n` +
      `For: ${slots.customerId}\n` +
      `Amount: ${formatMoney(amount, 'NGN')}\n` +
      (slots.itemName ? `Package: ${slots.itemName}\n` : '') +
      `\nTap below to confirm with your PIN.`,
    metadata: {
      intentId: intent.id,
      buttons: [{ id: 'confirm_send', label: 'Confirm payment', disabled: false }],
    },
    intentId: intent.id,
  };
}

export async function executeBillPayFromSlots(input: {
  userId: string;
  slots: Record<string, unknown>;
}): Promise<{ reference: string; message: string }> {
  const categoryCode = String(input.slots.categoryCode || '');
  const billerCode = String(input.slots.billerCode || '');
  const itemCode = String(input.slots.itemCode || '');
  const customerId = String(input.slots.customerId || '');
  const amount = Number(input.slots.amount);
  if (!categoryCode || !billerCode || !itemCode || !customerId || !(amount > 0)) {
    throw new Error('Bill payment is incomplete.');
  }

  const result = await billsService.payBill({
    userId: input.userId,
    categoryCode,
    billerCode,
    itemCode,
    customerId,
    amount,
    billerName: input.slots.billerName
      ? String(input.slots.billerName)
      : undefined,
    itemName: input.slots.itemName ? String(input.slots.itemName) : undefined,
  });

  const reference = String(
    result.reference || result.tx_ref || result.flw_ref || ''
  );
  const status = String(result.status || 'pending').toLowerCase();
  const label = categoryLabel(categoryCode as BillCategoryCode);
  if (status === 'success' || status === 'successful') {
    return {
      reference,
      message:
        `✅ ${label} payment successful.\n\n` +
        `${formatMoney(amount, 'NGN')} · ${customerId}\n` +
        (reference ? `Ref: ${reference}` : ''),
    };
  }
  return {
    reference,
    message:
      `⏳ ${label} payment submitted (${status}).\n\n` +
      `${formatMoney(amount, 'NGN')} · ${customerId}\n` +
      `I'll update you when Dayfi confirms the final status` +
      (reference ? ` (ref ${reference}).` : '.'),
  };
}
