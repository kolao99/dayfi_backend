/**
 * Azap Yellow Card off-ramp — conversational adapter over
 * PaymentService.walletFundedYellowCardSend (same path as SendHome).
 *
 * Active corridors only (channel status=active). GH bank may be inactive on YC
 * — we tell the user honestly rather than faking success.
 */
import YellowCardService, {
  parseYellowCardChannelList,
} from '../../payment/yellowCardService';
import PaymentService from '../../payment/services';
import { convertAmountToUsd } from '../../payment/fxService';
import { getPayoutQuote } from '../../payment/payoutQuoteService';
import { upsertActiveIntent } from '../intent/intentService';
import { formatMoney } from '../../payment/walletModel';
import { YELLOW_CARD_OFF_RAMP_CORRIDORS } from '../../infra/infraCorridors';

const paymentService = new PaymentService();
const yc = new YellowCardService();

export type YcReply = {
  role: 'assistant';
  type: 'text' | 'review' | 'choice';
  content: string;
  metadata?: Record<string, unknown>;
  intentId?: string;
};

const CURRENCY_COUNTRY: Record<string, string> = {
  GHS: 'GH',
  KES: 'KE',
  ZAR: 'ZA',
  UGX: 'UG',
  TZS: 'TZ',
  XOF: 'CI',
  XAF: 'CM',
  RWF: 'RW',
  MWK: 'MW',
  ZMW: 'ZM',
  BWP: 'BW',
  CDF: 'CD',
};

function corridorExists(currency: string): boolean {
  const ccy = currency.toUpperCase();
  return YELLOW_CARD_OFF_RAMP_CORRIDORS.some(
    (r) => r.currency.toUpperCase() === ccy
  );
}

async function pickWithdrawChannel(
  country: string,
  currency: string
): Promise<Record<string, unknown> | null> {
  const raw = await yc.fetchChannels();
  const list = parseYellowCardChannelList(raw);
  const matches = list.filter((ch) => {
    const c = String(ch.country || '').toUpperCase();
    const cur = String(ch.currency || ch.localCurrency || '').toUpperCase();
    const status = String(ch.status || 'active').toLowerCase();
    const ct = String(ch.channelType || '').toLowerCase();
    const rt = String(ch.rampType || '').toLowerCase();
    if (c !== country.toUpperCase()) return false;
    if (cur && cur !== currency.toUpperCase()) return false;
    if (status === 'inactive') return false;
    if (String(ch.id || '').startsWith('yc_fallback_')) return false;
    const bankLike = /bank|eft|p2p|transfer/.test(ct);
    const withdrawLike = !rt || /withdraw|payout/.test(rt);
    return bankLike && withdrawLike;
  });
  // Prefer explicit bank over momo/p2p
  matches.sort((a, b) => {
    const score = (ch: Record<string, unknown>) => {
      const ct = String(ch.channelType || '').toLowerCase();
      if (ct === 'bank' || ct === 'bank_transfer') return 0;
      if (ct === 'eft') return 1;
      return 2;
    };
    return score(a) - score(b);
  });
  return matches[0] || null;
}

async function listNetworksForChannel(
  country: string,
  channelId: string
): Promise<Array<{ id: string; name: string }>> {
  const raw = await yc.fetchNetworks();
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: unknown[] }).data as Record<string, unknown>[])
      : Array.isArray((raw as { networks?: unknown })?.networks)
        ? ((raw as { networks: unknown[] }).networks as Record<
            string,
            unknown
          >[])
        : [];
  return rows
    .filter((n) => {
      const nCountry = String(n.country || '').toUpperCase();
      if (nCountry && nCountry !== country.toUpperCase()) return false;
      const status = String(n.status || 'active').toLowerCase();
      if (status === 'inactive') return false;
      const ids = (n.channelIds || n.channel_ids || []) as string[];
      if (Array.isArray(ids) && ids.length) {
        return ids.map(String).includes(channelId);
      }
      return true;
    })
    .map((n) => ({
      id: String(n.id),
      name: String(n.name || n.code || n.id),
    }))
    .slice(0, 40);
}

export async function beginYellowCardSend(input: {
  userId: string;
  conversationId: string;
  currency: string;
  amount: number | null;
  recipientHint?: string | null;
}): Promise<YcReply> {
  if (!yc.isConfigured()) {
    return {
      role: 'assistant',
      type: 'text',
      content:
        'Cross-border sends (GHS, KES, ZAR, …) are not configured on this server right now.',
    };
  }

  const currency = input.currency.toUpperCase();
  if (!corridorExists(currency)) {
    return {
      role: 'assistant',
      type: 'text',
      content: `I don't support *${currency}* payouts yet.`,
    };
  }

  const country = CURRENCY_COUNTRY[currency];
  if (!country) {
    return {
      role: 'assistant',
      type: 'text',
      content: `I don't know which country maps to *${currency}* yet.`,
    };
  }

  let channel: Record<string, unknown> | null = null;
  try {
    channel = await pickWithdrawChannel(country, currency);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      role: 'assistant',
      type: 'text',
      content: `I couldn't load Yellow Card payout channels (${msg}). Try again shortly.`,
    };
  }

  if (!channel) {
    return {
      role: 'assistant',
      type: 'text',
      content:
        `*${currency}* payouts exist in the Dayfi app, but Yellow Card has no *active* bank/EFT withdrawal channel for ${country} right now.\n\n` +
        `I won't fake a send. Try KES (Kenya) if you need a live corridor, or send NGN / USDC on WhatsApp.`,
    };
  }

  const channelId = String(channel.id);
  let networks: Array<{ id: string; name: string }> = [];
  try {
    networks = await listNetworksForChannel(country, channelId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      role: 'assistant',
      type: 'text',
      content: `I found a ${currency} channel but couldn't load banks (${msg}).`,
    };
  }

  if (!networks.length) {
    return {
      role: 'assistant',
      type: 'text',
      content: `No active banks listed for ${currency} on Yellow Card right now.`,
    };
  }

  const amount = input.amount && input.amount > 0 ? input.amount : null;
  const intent = await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'SEND_YC',
    status: 'COLLECTING_INFORMATION',
    slots: {
      currency,
      country,
      channelId,
      channelName: String(channel.name || channel.channelName || currency),
      amountLocal: amount,
      recipientHint: input.recipientHint || null,
      networks: networks.slice(0, 15),
      awaiting: amount ? 'bank' : 'amount',
    },
  });

  const bankList = networks
    .slice(0, 8)
    .map((n, i) => `${i + 1}. ${n.name}`)
    .join('\n');

  if (!amount) {
    return {
      role: 'assistant',
      type: 'text',
      content:
        `Got it — *${currency}* send.\n\nHow much ${currency} should they receive?`,
      intentId: intent.id,
    };
  }

  return {
    role: 'assistant',
    type: 'text',
    content:
      `Sending *${formatMoney(amount, currency)}* (${country}).\n\n` +
      `Pick a bank (reply with the number or name):\n${bankList}\n\n` +
      `Then send the account number.`,
    intentId: intent.id,
  };
}

export async function continueYellowCardSend(input: {
  userId: string;
  conversationId: string;
  text: string;
  slots: Record<string, unknown>;
}): Promise<YcReply> {
  const slots = { ...input.slots };
  const text = String(input.text || '').trim();
  const awaiting = String(slots.awaiting || '');

  if (awaiting === 'amount' || (!slots.amountLocal && /^\d/.test(text))) {
    const n = Number(text.replace(/[^\d.]/g, ''));
    if (!(n > 0)) {
      return {
        role: 'assistant',
        type: 'text',
        content: `How much ${slots.currency} should they receive?`,
      };
    }
    slots.amountLocal = n;
    slots.awaiting = 'bank';
    await upsertActiveIntent({
      userId: input.userId,
      conversationId: input.conversationId,
      intent: 'SEND_YC',
      status: 'COLLECTING_INFORMATION',
      slots,
    });
    const networks = (slots.networks as Array<{ id: string; name: string }>) || [];
    const bankList = networks
      .slice(0, 8)
      .map((n, i) => `${i + 1}. ${n.name}`)
      .join('\n');
    return {
      role: 'assistant',
      type: 'text',
      content:
        `Amount: *${formatMoney(n, String(slots.currency))}*.\n\n` +
        `Pick a bank:\n${bankList}`,
    };
  }

  if (awaiting === 'bank' || (!slots.networkId && awaiting !== 'account')) {
    const networks =
      (slots.networks as Array<{ id: string; name: string }>) || [];
    const asNum = Number(text);
    let picked =
      Number.isFinite(asNum) && asNum >= 1 && asNum <= networks.length
        ? networks[asNum - 1]
        : networks.find((n) =>
            n.name.toLowerCase().includes(text.toLowerCase())
          );
    if (!picked) {
      return {
        role: 'assistant',
        type: 'text',
        content: 'Reply with the bank number or name from the list.',
      };
    }
    slots.networkId = picked.id;
    slots.bankName = picked.name;
    slots.awaiting = 'account';
    await upsertActiveIntent({
      userId: input.userId,
      conversationId: input.conversationId,
      intent: 'SEND_YC',
      status: 'COLLECTING_INFORMATION',
      slots,
    });
    return {
      role: 'assistant',
      type: 'text',
      content: `Bank: *${picked.name}*.\n\nWhat's the account number?`,
    };
  }

  if (awaiting === 'account' || !slots.accountNumber) {
    const accountNumber = text.replace(/\s+/g, '');
    if (accountNumber.length < 5) {
      return {
        role: 'assistant',
        type: 'text',
        content: 'Please send a valid account number.',
      };
    }
    slots.accountNumber = accountNumber;
    let accountName = String(slots.recipientHint || 'Beneficiary');
    try {
      const resolved = await yc.resolveBankDetailsYC(
        accountNumber,
        String(slots.networkId)
      );
      const name =
        (resolved as { accountName?: string; name?: string })?.accountName ||
        (resolved as { name?: string })?.name;
      if (name) accountName = String(name);
    } catch {
      /* keep hint */
    }
    slots.accountName = accountName;

    const amountLocal = Number(slots.amountLocal);
    const currency = String(slots.currency);
    const { usdAmount } = await convertAmountToUsd(amountLocal, currency);
    const feeUsd = Number(process.env.DAYFI_TRANSFER_FEE_USD ?? 0.05);
    const quote = await getPayoutQuote({
      amountUsd: usdAmount,
      targetCurrency: currency,
      feeUsd,
    });

    slots.sendAmountUsd = Number((usdAmount + feeUsd).toFixed(2));
    slots.receiveAmount = amountLocal;
    slots.feeUsd = feeUsd;
    slots.rate = quote.exchangeRate;

    const intent = await upsertActiveIntent({
      userId: input.userId,
      conversationId: input.conversationId,
      intent: 'SEND_YC',
      status: 'AWAITING_CONFIRMATION',
      slots: { ...slots, awaiting: 'confirm' },
    });

    return {
      role: 'assistant',
      type: 'review',
      content:
        `Send *${formatMoney(amountLocal, currency)}*\n\n` +
        `To: ${accountName}\n` +
        `Bank: ${slots.bankName}\n` +
        `Account: ${accountNumber}\n\n` +
        `From your wallet: ~*${Number(usdAmount).toFixed(2)} USDC*\n` +
        `Fee: ~$${feeUsd.toFixed(2)}\n` +
        `Total debit: ~*${slots.sendAmountUsd} USDC*\n\n` +
        `Tap below to confirm with your PIN.`,
      metadata: {
        intentId: intent.id,
        buttons: [{ id: 'confirm_send', title: 'Confirm send' }],
      },
      intentId: intent.id,
    };
  }

  return {
    role: 'assistant',
    type: 'text',
    content: 'Say cancel to stop, or send the missing bank details.',
  };
}

export async function executeYellowCardSendFromSlots(input: {
  userId: string;
  slots: Record<string, unknown>;
}): Promise<{ reference: string; message: string }> {
  const s = input.slots;
  const result = await paymentService.walletFundedYellowCardSend(
    {
      userId: input.userId,
      sendAmount: Number(s.sendAmountUsd) - Number(s.feeUsd || 0),
      payWithCurrency: 'USD',
      feeUsd: Number(s.feeUsd || 0),
      receiveAmount: Number(s.receiveAmount || s.amountLocal),
      receiveCurrency: String(s.currency),
      country: String(s.country),
      channelId: String(s.channelId),
      networkId: String(s.networkId),
      accountNumber: String(s.accountNumber),
      accountName: String(s.accountName || 'Beneficiary'),
      accountType: 'bank',
      reason: 'other',
      bankName: s.bankName ? String(s.bankName) : undefined,
      recipient: {
        name: String(s.accountName || 'Beneficiary'),
        country: String(s.country),
        phone: '+2340000000000',
        address: 'Not provided',
        dob: '1990-01-01',
        email: 'user@dayfi.co',
        idNumber: 'A00000000',
        idType: 'passport',
      },
    },
    yc
  );

  const ref = result.paymentSequenceId || result.collectionSequenceId;
  return {
    reference: ref,
    message:
      `✅ Yellow Card send submitted.\n` +
      `Ref: ${ref}\n` +
      `${formatMoney(Number(s.receiveAmount || s.amountLocal), String(s.currency))} → ${s.accountName}\n` +
      `Final status will update when Yellow Card confirms.`,
  };
}

export { corridorExists, CURRENCY_COUNTRY };
