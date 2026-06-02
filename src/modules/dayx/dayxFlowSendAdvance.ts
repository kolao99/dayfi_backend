import { db } from '../../config/database';
import PaymentService from '../payment/services';
import type { DayxFlowContext } from './dayxFlowContext';
import {
  CORE_DESTINATION_OPTIONS,
  deliveryMethodsForCorridor,
  methodStepReply,
} from './dayxFlowDelivery';
import { countryReply } from './dayxFlowNlu';
import { buildSlotAck, isNgAccountNumber, isRecipientResolved, resolveAmountFromSessionData } from './dayxFlowSlots';
import { extractFlowSlots } from './dayxSlotExtractor';
import type {
  DayxFlowExecutePayload,
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
  DayxFlowUi,
} from './dayxFlowTypes';
import { sortNgBanksForPicker } from './dayxFlowBanks';
import { balanceFor, walletOptionsFromBalances } from './dayxFlowWallets';
import { slotsToSessionData } from './dayxFlowSlots';

const paymentService = new PaymentService();

async function dayfiUserDisplayName(
  userId: string,
  wallet: { account_name?: string; dayfi_id?: string }
): Promise<{
  displayName: string;
  firstName: string;
  lastName: string;
}> {
  const userRow = await db.oneOrNone<{
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT first_name, last_name FROM users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const firstName = userRow?.first_name?.trim() ?? '';
  const lastName = userRow?.last_name?.trim() ?? '';
  const full = `${firstName} ${lastName}`.trim();
  const displayName =
    full ||
    String(wallet.account_name ?? '').trim() ||
    String(wallet.dayfi_id ?? 'User');
  return { displayName, firstName, lastName };
}

const NG_BANK_HINT =
  'Opay, PalmPay, GTBank, Access, UBA, and other Nigerian banks';

let banksCache: Array<{ code: string; name: string }> | null = null;

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

export function withData(
  session: DayxFlowSession,
  patch: Record<string, unknown>
): DayxFlowSession {
  return { ...session, data: { ...data(session), ...patch } };
}

async function loadBanks(): Promise<Array<{ code: string; name: string }>> {
  if (banksCache?.length) return sortNgBanksForPicker(banksCache);
  const raw = await paymentService.fetchNigerianBankNetworks();
  const mapped = raw.map((b: { code: string; name: string }) => ({
    code: b.code,
    name: b.name,
  }));
  banksCache = sortNgBanksForPicker(mapped);
  return banksCache;
}

export async function resolveBankCodeFromName(
  bankName: string
): Promise<{ code: string; name: string } | null> {
  const q = bankName.toLowerCase().trim();
  const banks = await loadBanks();
  const exact = banks.find((b) => b.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = banks.find(
    (b) =>
      b.name.toLowerCase().includes(q) ||
      q.includes(b.name.toLowerCase().slice(0, 4))
  );
  return partial ?? null;
}

function amountUi(spendCurrency: string): DayxFlowUi {
  const balHint = '';
  return {
    step: 'input_amount',
    title: 'Amount',
    input: {
      type: 'amount',
      field: 'amount',
      label: `Amount (${spendCurrency})`,
      placeholder: 'Enter amount',
      keyboard: 'number',
    },
    showBack: true,
    hint: balHint,
  };
}

function reviewLines(d: Record<string, unknown>): { label: string; value: string }[] {
  const spend = String(d.spendCurrency ?? 'NGN');
  const receive = String(d.receiveCurrency ?? 'NGN');
  const amount = Number(d.amount);
  const method = String(d.deliveryMethod ?? '');
  return [
    { label: 'From', value: spend },
    {
      label: 'To',
      value: `${countryReply(String(d.receiveCountry ?? 'NG'))} (${receive})`,
    },
    {
      label: 'Recipient',
      value: String(
        d.recipientName ??
          (d.recipientFirstName && d.recipientLastName
            ? `${d.recipientFirstName} ${d.recipientLastName}`
            : null) ??
          d.accountName ??
          (d.dayfiId ? `@${d.dayfiId}` : null) ??
          d.phone ??
          'Recipient'
      ),
    },
    { label: 'Amount', value: `${spend} ${amount.toLocaleString()}` },
    {
      label: 'Method',
      value:
        method === 'dayfi_tag'
          ? 'Dayfi Tag'
          : method === 'crypto'
            ? `Crypto (${d.cryptoNetwork ?? 'on-chain'})`
            : 'Bank transfer',
    },
  ];
}

export async function mergeSlotsIntoSendSession(
  session: DayxFlowSession,
  utterance?: string
): Promise<DayxFlowSession> {
  const slots = await extractFlowSlots(utterance);
  const patch = slotsToSessionData(slots, 'send');
  return withData(session, { ...patch, _lastSlots: slots });
}

export async function advanceSend(
  session: DayxFlowSession,
  ctx: DayxFlowContext,
  opts?: { ackPrefix?: string }
): Promise<DayxFlowTurnResult> {
  const d = data(session);
  const ack = opts?.ackPrefix ?? buildSlotAck(d, 'send');

  if (!d.spendCurrency) {
    return {
      reply: ack
        ? `${ack} Which wallet are you sending from?`
        : 'Which wallet are you sending from? You have NGN, USD, EUR, and GBP.',
      session: { ...session, step: 'select_spend_wallet' },
      ui: {
        step: 'select_spend_wallet',
        title: 'Send from',
        options: walletOptionsFromBalances(ctx.balances),
        showBack: false,
      },
    };
  }

  const spend = String(d.spendCurrency).toUpperCase();
  let working = session;

  if (!d.receiveCountry || !d.receiveCurrency) {
    if (d.deliveryMethod === 'bank' && spend === 'NGN') {
      working = withData(working, {
        receiveCountry: 'NG',
        receiveCurrency: 'NGN',
      });
    } else if (d.deliveryMethod === 'crypto') {
      working = withData(working, {
        receiveCountry: spend === 'EUR' ? 'DE' : 'US',
        receiveCurrency: spend,
      });
    } else if (d.deliveryMethod === 'dayfi_tag') {
      working = withData(working, {
        receiveCountry: 'NG',
        receiveCurrency: 'NGN',
      });
    }
  }

  const d1 = data(working);
  if (!d1.receiveCountry || !d1.receiveCurrency) {
    return {
      reply: ack
        ? `${ack} Where are they receiving the money?`
        : `Sending from ${spend}. Where are they receiving the money?`,
      session: { ...working, step: 'select_country' },
      ui: {
        step: 'select_country',
        title: 'Destination',
        options: CORE_DESTINATION_OPTIONS,
        showBack: true,
      },
    };
  }

  working = { ...working, step: 'select_method' };
  const d2 = data(working);

  if (!d2.deliveryMethod) {
    const country = String(d2.receiveCountry);
    const receive = String(d2.receiveCurrency);
    const methods = deliveryMethodsForCorridor(country, receive);
    return {
      reply: ack
        ? `${ack} How should they receive it?`
        : methodStepReply(spend, receive),
      session: withData(working, {}),
      ui: {
        step: 'select_method',
        title: 'Choose delivery method',
        options: methods,
        hint: methodStepReply(spend, receive),
        showBack: true,
      },
    };
  }

  const method = String(d2.deliveryMethod);

  if (
    method === 'bank' &&
    String(d2.receiveCountry) === 'NG' &&
    !d2.bankCode
  ) {
    if (d2.bank_name) {
      const bank = await resolveBankCodeFromName(String(d2.bank_name));
      if (bank) {
        working = withData(working, {
          bankCode: bank.code,
          bankName: bank.name,
        });
      } else {
        return askBankPicker(working, ack);
      }
    } else if (!d2.accountNumber) {
      return askBankPicker(working, ack);
    }
  }

  if (method === 'crypto' && !d2.cryptoNetwork && !d2.cryptoAddress) {
    if (d2.recipient_raw && String(d2.recipient_raw).length >= 20) {
      working = withData(working, {
        cryptoAddress: d2.recipient_raw,
        cryptoNetwork: 'stellar',
        recipient_resolved: true,
      });
    } else {
      return {
        reply: ack
          ? `${ack} Select the network, then paste the address.`
          : 'Select the network for this crypto transfer.',
        session: { ...working, step: 'select_crypto_network' },
        ui: {
          step: 'select_crypto_network',
          title: 'Network',
          options: [
            { id: 'stellar', label: 'Stellar', subtitle: 'Recommended' },
            { id: 'eth', label: 'Ethereum', subtitle: 'ERC-20' },
          ],
          showBack: true,
        },
      };
    }
  }

  const d3 = data(working);

  if (!isRecipientResolved(d3)) {
    if (d3.recipient_raw || d3.accountNumber || d3.dayfiId) {
      return resolveRecipient(working, ctx, ack);
    }
    return askRecipient(working, method, ack);
  }

  const d4 = data(working);
  const available = balanceFor(ctx.balances, spend);
  const resolved = resolveAmountFromSessionData(d4, available);

  if (resolved == null) {
    if (d4.amountMode === 'max') {
      return {
        reply: ack
          ? `${ack} You have no ${spend} balance to send.`
          : `You have no ${spend} balance to send.`,
        session: working,
      };
    }
    return {
      reply: ack
        ? `${ack} How much? You have ${available.toLocaleString()} ${spend} available.`
        : `How much ${spend} do you want to send? Available: ${available.toLocaleString()}.`,
      session: withData(working, { step: 'input_amount' }),
      ui: {
        ...amountUi(spend),
        hint: `Available: ${available.toLocaleString()} ${spend}`,
      },
    };
  }

  return submitAmountForReview(working, ctx, resolved, ack);
}

function askBankPicker(
  session: DayxFlowSession,
  ack: string
): Promise<DayxFlowTurnResult> {
  return loadBanks().then((banks) => {
    const options = banks.map((b) => ({
      id: b.code,
      label: b.name,
      subtitle: b.code,
    }));
    return {
      reply: ack
        ? `${ack} Which bank? Popular banks are at the top — scroll for more.`
        : `Choose their bank. Opay, PalmPay, GTB and others are at the top. Scroll for the full list.`,
      session: withData({ ...session, step: 'select_bank' }, {}),
      ui: {
        step: 'select_bank',
        title: 'Bank',
        options,
        hint: 'Popular banks first · scroll for more',
        showBack: true,
      },
    };
  });
}

function bankAccountCollectUi(): DayxFlowUi {
  return {
    step: 'collect_recipient',
    title: 'Account number',
    input: {
      type: 'text',
      field: 'accountNumber',
      label: 'Account number',
      placeholder: '10 digits',
      keyboard: 'number',
    },
    hint: NG_BANK_HINT,
    showBack: true,
  };
}

function askRecipient(
  session: DayxFlowSession,
  method: string,
  ack: string
): DayxFlowTurnResult {
  const prefix = ack ? `${ack} ` : '';

  if (method === 'dayfi_tag') {
    return {
      reply: `${prefix}Enter their Dayfi username (with or without @).`,
      session: withData({ ...session, step: 'collect_recipient' }, {}),
      ui: {
        step: 'collect_recipient',
        title: 'Username',
        input: {
          type: 'text',
          field: 'dayfiId',
          label: 'Dayfi Tag',
          placeholder: 'e.g. johndoe',
          keyboard: 'default',
        },
        showBack: true,
      },
    };
  }

  if (method === 'bank') {
    return {
      reply: `${prefix}Enter their account number.`,
      session: withData({ ...session, step: 'collect_recipient' }, {}),
      ui: bankAccountCollectUi(),
    };
  }

  return {
    reply: `${prefix}Paste their wallet address.`,
    session: withData({ ...session, step: 'collect_recipient' }, {}),
    ui: {
      step: 'collect_recipient',
      title: 'Wallet address',
      input: {
        type: 'multiline',
        field: 'cryptoAddress',
        label: 'Wallet address',
        placeholder: 'Paste address',
        keyboard: 'default',
      },
      showBack: true,
    },
  };
}

async function resolveRecipient(
  session: DayxFlowSession,
  ctx: DayxFlowContext,
  ack: string
): Promise<DayxFlowTurnResult> {
  const d = data(session);
  const method = String(d.deliveryMethod ?? '');

  if (method === 'dayfi_tag') {
    const tag = String(d.dayfiId ?? d.recipient_raw ?? '').replace(/^@/, '');
    try {
      const wallet = await paymentService.getWalletByDayfiId(tag);
      if (!wallet?.user_id) {
        return {
          reply: `No DayFi user found for @${tag}. Check the tag and try again.`,
          session,
        };
      }
      const { displayName, firstName, lastName } = await dayfiUserDisplayName(
        String(wallet.user_id),
        wallet
      );
      const next = withData(session, {
        dayfiId: tag,
        recipientName: displayName,
        recipientFirstName: firstName,
        recipientLastName: lastName,
        dayfiVerified: true,
        recipient_resolved: true,
      });
      const prefix =
        ack ||
        (firstName && lastName
          ? `Found ${firstName} ${lastName}.`
          : `Found ${displayName}.`);
      if (d.amount) {
        return submitAmountForReview(next, ctx, Number(d.amount), prefix);
      }
      return advanceSend(next, ctx, { ackPrefix: prefix });
    } catch (e: unknown) {
      return {
        reply: e instanceof Error ? e.message : 'Could not verify Dayfi Tag.',
        session,
      };
    }
  }

  if (method === 'bank') {
    const accountNumber = String(d.accountNumber ?? d.recipient_raw ?? '');
    let bankCode = String(d.bankCode ?? '');
    if (!bankCode && d.bank_name) {
      const bank = await resolveBankCodeFromName(String(d.bank_name));
      if (bank) bankCode = bank.code;
    }
    if (!bankCode || !accountNumber) {
      return askRecipient(session, method, ack);
    }
    try {
      const resolved = await paymentService.resolveBankAccount(
        accountNumber,
        bankCode
      );
      const accountName =
        resolved?.accountName ?? resolved?.account_name ?? 'Recipient';
      const bank = (await loadBanks()).find((b) => b.code === bankCode);
      const next = withData(session, {
        accountNumber,
        bankCode,
        bankName: bank?.name ?? String(d.bank_name ?? 'Bank'),
        accountName: String(accountName),
        recipient_resolved: true,
      });
      const prefix = `${ack ? `${ack} ` : ''}Account verified: ${accountName}.`.trim();
      if (d.amount) {
        return submitAmountForReview(next, ctx, Number(d.amount), prefix);
      }
      return advanceSend(next, ctx, { ackPrefix: prefix });
    } catch (e: unknown) {
      return {
        reply:
          e instanceof Error
            ? e.message
            : 'Could not verify account. Check the number and try again.',
        session: withData({ ...session, step: 'collect_recipient' }, {
          recipient_resolved: false,
        }),
        ui: bankAccountCollectUi(),
      };
    }
  }

  if (method === 'crypto') {
    const addr = String(d.cryptoAddress ?? d.recipient_raw ?? '');
    if (addr.length < 20) {
      return askRecipient(session, method, ack);
    }
    const next = withData(session, {
      cryptoAddress: addr,
      cryptoNetwork: d.cryptoNetwork ?? 'stellar',
      recipient_resolved: true,
    });
    if (d.amount) {
      return submitAmountForReview(next, ctx, Number(d.amount), ack);
    }
    return advanceSend(next, ctx, { ackPrefix: ack });
  }

  return askRecipient(session, method, ack);
}

export async function submitAmountForReview(
  session: DayxFlowSession,
  ctx: DayxFlowContext,
  amount: number,
  ack?: string
): Promise<DayxFlowTurnResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { reply: 'Enter a valid amount greater than zero.', session };
  }

  const d = data(session);
  const spendCurrency = String(d.spendCurrency ?? 'NGN').toUpperCase();
  const available = balanceFor(ctx.balances, spendCurrency);

  if (amount > available) {
    return {
      reply: `You only have ${available.toLocaleString()} ${spendCurrency}. Want to top up first?`,
      session: withData(session, { amount }),
      ui: {
        step: 'review',
        title: 'Insufficient balance',
        panel: 'insufficient_balance',
        review: [
          {
            label: 'Needed',
            value: `${spendCurrency} ${amount.toLocaleString()}`,
          },
          {
            label: 'Available',
            value: `${spendCurrency} ${available.toLocaleString()}`,
          },
        ],
        options: [
          { id: 'top_up', label: 'Top up wallet' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    };
  }

  const next = withData({ ...session, step: 'review' }, { amount });
  const review = reviewLines({ ...data(next), amount });
  const prefix = ack ? `${ack} ` : '';

  return {
    reply: `${prefix}Here's your transfer summary. Confirm when ready.`.trim(),
    session: next,
    ui: {
      step: 'review',
      title: 'Review transfer',
      review,
      options: [
        { id: 'confirm', label: 'Confirm' },
        { id: 'cancel', label: 'Cancel' },
      ],
    },
  };
}

export function buildExecutePayload(
  d: Record<string, unknown>
): DayxFlowExecutePayload | null {
  const method = String(d.deliveryMethod ?? '');
  const amount = Number(d.amount);
  const spendCurrency = String(d.spendCurrency ?? 'NGN').toUpperCase();

  if (method === 'dayfi_tag' && d.dayfiId) {
    return {
      type: 'dayfi_tag',
      dayfiId: String(d.dayfiId),
      amount: Math.round(amount),
      debitCurrency: spendCurrency,
    };
  }

  if (method === 'bank' && d.accountNumber) {
    return {
      type: 'ngn_bank',
      amount,
      accountNumber: String(d.accountNumber),
      bankCode: String(d.bankCode ?? ''),
      bankName: String(d.bankName ?? 'Bank'),
      accountName: String(d.accountName ?? 'Recipient'),
      fee: 0,
      spendCurrency,
    };
  }

  return null;
}

export async function applyMethodSelect(
  session: DayxFlowSession,
  methodId: string,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const next = withData({ ...session, step: 'advance' }, {
    deliveryMethod: methodId,
  });
  return advanceSend(next, ctx);
}

export async function handleCountrySelect(
  session: DayxFlowSession,
  optionId: string,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const [country, currency] = (optionId ?? '').split('|');
  if (!country || !currency) {
    return { reply: 'Pick a destination country.', session };
  }
  const next = withData(session, {
    receiveCountry: country,
    receiveCurrency: currency,
  });
  return advanceSend(next, ctx);
}

export async function handleBankSelect(
  session: DayxFlowSession,
  bankCode: string,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const banks = await loadBanks();
  const bank = banks.find((b) => b.code === bankCode);
  const next = withData(session, {
    bankCode,
    bankName: bank?.name ?? 'Bank',
  });
  return advanceSend(next, ctx);
}

export async function handleCryptoNetworkSelect(
  session: DayxFlowSession,
  network: string,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const next = withData(session, { cryptoNetwork: network });
  return advanceSend(next, ctx);
}

export async function handleRecipientFieldSubmit(
  session: DayxFlowSession,
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const field = body.field ?? '';
  const value = String(body.value ?? '').trim();
  if (!value) {
    return { reply: 'Please enter a value to continue.', session };
  }

  let next = session;
  const utterance = body.utterance ?? value;
  const structuredFields = new Set(['accountNumber', 'dayfiId', 'cryptoAddress', 'amount']);
  if (
    !structuredFields.has(field) &&
    utterance.split(/\s+/).length >= 4
  ) {
    next = await mergeSlotsIntoSendSession(session, utterance);
  }

  const d = data(next);
  const method = String(d.deliveryMethod ?? '');

  if (field === 'dayfiId' || (method === 'dayfi_tag' && field === 'amount')) {
    const tag = value.replace(/^@/, '');
    next = withData(next, { dayfiId: tag, recipient_raw: tag });
    return advanceSend(next, ctx);
  }

  if (field === 'accountNumber') {
    const digits = value.replace(/\D/g, '');
    if (!isNgAccountNumber(digits)) {
      return {
        reply: 'Enter a valid 10-digit Nigerian account number.',
        session: withData(session, { step: 'collect_recipient' }),
        ui: bankAccountCollectUi(),
      };
    }
    const merged: Record<string, unknown> = {
      ...data(session),
      accountNumber: digits,
      recipient_raw: digits,
    };
    if (Number(merged.amount) === Number(digits)) {
      delete merged.amount;
    }
    next = { ...session, step: 'collect_recipient', data: merged };
    return resolveRecipient(next, ctx, '');
  }

  if (field === 'cryptoAddress') {
    next = withData(next, {
      cryptoAddress: value,
      recipient_raw: value,
    });
    return advanceSend(next, ctx);
  }

  if (field === 'amount') {
    const num = Number(String(value).replace(/,/g, ''));
    if (Number.isFinite(num) && num > 0) {
      return submitAmountForReview(next, ctx, num);
    }
    if (utterance.trim()) {
      next = await mergeSlotsIntoSendSession(next, utterance);
      const spend = String(data(next).spendCurrency ?? 'NGN');
      const available = balanceFor(ctx.balances, spend);
      const resolved = resolveAmountFromSessionData(data(next), available);
      if (resolved != null) {
        return submitAmountForReview(next, ctx, resolved);
      }
    }
    return {
      reply: 'Enter a valid amount, or say "all" to send your full balance.',
      session: next,
      ui: amountUi(String(data(next).spendCurrency ?? 'NGN')),
    };
  }

  return advanceSend(next, ctx);
}
