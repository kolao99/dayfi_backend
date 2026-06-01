import PaymentService from '../payment/services';
import type { DayxFlowContext } from './dayxFlowContext';
import { countryLabel } from './dayxFlowChannels';
import {
  CORE_DESTINATION_OPTIONS,
  deliveryMethodsForCorridor,
  isCoreReceiveCurrency,
  methodStepReply,
} from './dayxFlowDelivery';
import { countryReply, parseFlowUtterance } from './dayxFlowNlu';
import { handleAddMoneyFlowTurn } from './dayxFlowAddMoney';
import type {
  DayxFlowExecutePayload,
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
  DayxFlowUi,
} from './dayxFlowTypes';
import { balanceFor, walletOptionsFromBalances } from './dayxFlowWallets';

const paymentService = new PaymentService();

const NG_BANK_HINT =
  'Opay, PalmPay, GTBank, Access, UBA, and other Nigerian banks';

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

function withData(
  session: DayxFlowSession,
  patch: Record<string, unknown>
): DayxFlowSession {
  return { ...session, data: { ...data(session), ...patch } };
}

function amountUi(spendCurrency: string): DayxFlowUi {
  return {
    step: 'input_amount',
    title: 'Amount',
    input: {
      type: 'amount',
      field: 'amount',
      label: `Amount (${spendCurrency})`,
      placeholder: '0.00',
      keyboard: 'number',
    },
    showBack: true,
  };
}

function reviewLines(d: Record<string, unknown>): { label: string; value: string }[] {
  const spend = String(d.spendCurrency ?? 'NGN');
  const receive = String(d.receiveCurrency ?? 'NGN');
  const amount = Number(d.amount);
  const method = String(d.deliveryMethod ?? '');
  return [
    { label: 'From', value: spend },
    { label: 'To', value: `${countryReply(String(d.receiveCountry ?? 'NG'))} (${receive})` },
    {
      label: 'Recipient',
      value: String(
        d.accountName ?? d.dayfiId ?? d.phone ?? d.recipientName ?? 'Recipient'
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

export async function handleSendFlowTurn(
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const session: DayxFlowSession = body.session ?? {
    flow: 'send',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return {
      reply: 'Send cancelled. What else can I help with?',
      session: null,
    };
  }

  if (body.action === 'start' || session.step === 'idle') {
    const slots = parseFlowUtterance(body.utterance ?? ctx.utterance);
    const patch: Record<string, unknown> = { ...slots };
    if (slots.receiveCountry) {
      patch.receiveCountry = slots.receiveCountry;
      patch.receiveCurrency = slots.receiveCurrency;
    }
    if (slots.recipientHint) patch.recipientHint = slots.recipientHint;
    if (slots.amount != null) patch.amount = slots.amount;

    const options = walletOptionsFromBalances(ctx.balances);
    let reply =
      'Which wallet are you sending from? You have NGN, USD, EUR, and GBP.';
    if (slots.receiveCountry) {
      reply = `Sending to ${countryReply(slots.receiveCountry)}. ${reply}`;
    }
    if (slots.recipientHint) {
      reply = `Got it — your ${slots.recipientHint}. ${reply}`;
    }

    return {
      reply,
      session: {
        flow: 'send',
        step: 'select_spend_wallet',
        data: patch,
      },
      ui: {
        step: 'select_spend_wallet',
        title: 'Send from',
        options,
        showBack: false,
      },
    };
  }

  if (session.step === 'select_spend_wallet' && body.action === 'select') {
    const spendCurrency = (body.optionId ?? 'NGN').toUpperCase();
    const d = data(session);
    const next = withData(
      { ...session, step: 'select_country' },
      { spendCurrency }
    );

    if (d.receiveCountry && d.receiveCurrency) {
      return advanceToMethod(
        next,
        ctx,
        String(d.receiveCountry),
        String(d.receiveCurrency)
      );
    }

    return {
      reply: `Sending from your ${spendCurrency} wallet. Where are they receiving the money?`,
      session: next,
      ui: {
        step: 'select_country',
        title: 'Destination',
        options: CORE_DESTINATION_OPTIONS,
        showBack: true,
      },
    };
  }

  if (session.step === 'select_country' && body.action === 'select') {
    const raw = body.optionId ?? '';
    const [country, currency] = raw.split('|');
    if (!country || !currency) {
      return { reply: 'Pick a destination country.', session };
    }
    return advanceToMethod(
      withData(session, { receiveCountry: country, receiveCurrency: currency }),
      ctx,
      country,
      currency
    );
  }

  if (session.step === 'select_method' && body.action === 'select') {
    return handleMethodSelect(session, body.optionId ?? 'bank', ctx);
  }

  if (session.step === 'select_bank' && body.action === 'select') {
    const bankCode = body.optionId ?? '';
    const banks = await paymentService.fetchNigerianBankNetworks();
    const bank = banks.find((b: { code: string }) => b.code === bankCode);
    const next = withData(
      { ...session, step: 'collect_recipient' },
      { bankCode, bankName: bank?.name ?? 'Bank' }
    );
    return {
      reply: `Enter their account number (${bank?.name ?? 'bank'}). ${NG_BANK_HINT}.`,
      session: next,
      ui: {
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
      },
    };
  }

  if (session.step === 'select_crypto_network' && body.action === 'select') {
    const network = body.optionId ?? 'stellar';
    return {
      reply: 'Paste their wallet address below.',
      session: withData(
        { ...session, step: 'collect_recipient' },
        { cryptoNetwork: network }
      ),
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

  if (session.step === 'collect_recipient' && body.action === 'submit') {
    return handleRecipientSubmit(session, body, ctx);
  }

  if (session.step === 'input_amount' && body.action === 'submit') {
    return handleAmountSubmit(session, body, ctx);
  }

  if (body.action === 'select' && body.optionId === 'top_up') {
    const spend = String(data(session).spendCurrency ?? 'NGN');
    return handleAddMoneyFlowTurn(
      {
        flow: 'add_money',
        action: 'select',
        optionId: spend,
        session: {
          flow: 'add_money',
          step: 'select_wallet',
          data: { resumeParent: session, currency: spend },
        },
      },
      ctx
    ) as Promise<DayxFlowTurnResult>;
  }

  if (session.step === 'review' && body.action === 'select') {
    if (body.optionId === 'cancel') {
      return { reply: 'Transfer cancelled.', session: null };
    }
    if (body.optionId === 'confirm') {
      const d = data(session);
      const exec = buildExecutePayload(d);
      if (!exec) {
        return { reply: 'Something is missing. Please start again.', session: null };
      }
      return {
        reply: 'Enter your transaction PIN below to confirm.',
        session: withData({ ...session, step: 'collect_pin' }, { executeDraft: exec }),
        awaitingPin: true,
        execute: exec as DayxFlowTurnResult['execute'],
        ui: {
          step: 'collect_pin',
          title: 'Transaction PIN',
          input: {
            type: 'pin',
            field: 'pin',
            label: '4-digit PIN',
            placeholder: '••••',
            keyboard: 'number',
          },
        },
      };
    }
  }

  if (session.step === 'collect_pin' && body.action === 'submit') {
    const pin = String(body.value ?? '').trim();
    if (pin.length < 4) {
      return { reply: 'Enter your 4-digit transaction PIN.', session };
    }
    const d = data(session);
    const exec = buildExecutePayload(d) as DayxFlowExecutePayload | null;
    if (!exec) {
      return { reply: 'Session expired. Please start again.', session: null };
    }
    return {
      reply: 'Processing your transfer…',
      session: null,
      awaitingPin: true,
      execute: { ...exec, pin } as DayxFlowExecutePayload,
      completed: true,
    };
  }

  return {
    reply: 'Choose an option above or say cancel.',
    session,
  };
}

async function advanceToMethod(
  session: DayxFlowSession,
  _ctx: DayxFlowContext,
  country: string,
  currency: string
): Promise<DayxFlowTurnResult> {
  const spend = String(data(session).spendCurrency ?? 'NGN');
  const receive = currency.toUpperCase();
  const methods = deliveryMethodsForCorridor(country, receive);

  return {
    reply: isCoreReceiveCurrency(receive)
      ? methodStepReply(spend, receive)
      : `How should they receive it in ${countryLabel(country)}?`,
    session: withData(
      { ...session, step: 'select_method' },
      { receiveCountry: country, receiveCurrency: receive }
    ),
    ui: {
      step: 'select_method',
      title: 'Choose delivery method',
      options: methods,
      hint: methodStepReply(spend, receive),
      showBack: true,
    },
  };
}

function handleMethodSelect(
  session: DayxFlowSession,
  method: string,
  _ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> | DayxFlowTurnResult {
  const country = String(data(session).receiveCountry ?? '');
  const currency = String(data(session).receiveCurrency ?? '');
  const next = withData(
    { ...session, step: 'collect_recipient' },
    { deliveryMethod: method }
  );

  if (method === 'dayfi_tag') {
    return {
      reply: 'Enter their username (without @).',
      session: next,
      ui: {
        step: 'collect_recipient',
        title: 'Username',
        input: {
          type: 'text',
          field: 'dayfiId',
          label: 'Dayfi Tag',
          placeholder: 'e.g. kolawole',
          keyboard: 'default',
        },
        showBack: true,
      },
    };
  }

  if (method === 'bank' && country === 'NG' && currency === 'NGN') {
    return paymentService.fetchNigerianBankNetworks().then((banks) => {
      const options = banks.slice(0, 40).map((b: { code: string; name: string }) => ({
        id: b.code,
        label: b.name,
        subtitle: b.code,
      }));
      return {
        reply: `Choose their bank. Supports ${NG_BANK_HINT}.`,
        session: withData(next, {}),
        ui: {
          step: 'select_bank',
          title: 'Bank',
          options,
          showBack: true,
        },
      };
    });
  }

  if (method === 'crypto') {
    const spend = String(data(session).spendCurrency ?? 'USD').toUpperCase();
    const coin = spend === 'EUR' ? 'EURC' : 'USDC';
    return {
      reply: `Select the network for ${coin}.`,
      session: { ...session, step: 'select_crypto_network', data: next.data },
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

  if (method === 'mobile_money') {
    return {
      reply: 'Enter their mobile money number.',
      session: next,
      ui: {
        step: 'collect_recipient',
        title: 'Phone number',
        input: {
          type: 'text',
          field: 'phone',
          label: 'Mobile money number',
          placeholder: '08012345678',
          keyboard: 'phone',
        },
        showBack: true,
      },
    };
  }

  return {
    reply: `Bank transfer to ${countryLabel(country)} is not fully supported in DayX yet. Try Dayfi Tag or NGN bank.`,
    session,
  };
}

async function handleRecipientSubmit(
  session: DayxFlowSession,
  body: DayxFlowTurnBody,
  _ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const field = body.field ?? '';
  const value = String(body.value ?? '').trim();
  if (!value) {
    return { reply: 'Please enter a value to continue.', session };
  }

  const d = data(session);
  const method = String(d.deliveryMethod ?? '');

  if (field === 'dayfiId') {
    const tag = value.replace(/^@/, '');
    try {
      const wallet = await paymentService.getWalletByDayfiId(tag);
      if (!wallet?.user_id) {
        return {
          reply: `No DayFi user found for @${tag}. Check the tag and try again.`,
          session,
        };
      }
      const name =
        wallet.account_name ?? wallet.first_name ?? wallet.dayfi_id ?? tag;
      const next = withData(
        { ...session, step: 'input_amount' },
        { dayfiId: tag, recipientName: String(name), dayfiVerified: true }
      );
      return amountStepResult(
        next,
        body,
        _ctx,
        `Found @${tag} (${name}). How much do you want to send?`
      );
    } catch (e: unknown) {
      return {
        reply: e instanceof Error ? e.message : 'Could not verify Dayfi Tag.',
        session,
      };
    }
  }

  if (field === 'accountNumber') {
    const bankCode = String(d.bankCode ?? '');
    try {
      const resolved = await paymentService.resolveBankAccount(value, bankCode);
      const accountName =
        resolved?.accountName ?? resolved?.account_name ?? 'Recipient';
      const next = withData(
        { ...session, step: 'input_amount' },
        { accountNumber: value, accountName: String(accountName) }
      );
      return amountStepResult(
        next,
        body,
        _ctx,
        `Account verified: ${accountName}. How much should I send?`
      );
    } catch (e: unknown) {
      return {
        reply:
          e instanceof Error
            ? e.message
            : 'Could not verify account. Check the number and try again.',
        session,
      };
    }
  }

  if (field === 'cryptoAddress') {
    if (value.length < 20) {
      return {
        reply: 'That address looks too short. Paste the full wallet address.',
        session,
      };
    }
    const next = withData(
      { ...session, step: 'input_amount' },
      { cryptoAddress: value }
    );
    return amountStepResult(
      next,
      body,
      _ctx,
      'How much do you want to send?'
    );
  }

  if (method === 'mobile_money' && field === 'phone') {
    const next = withData(
      { ...session, step: 'input_amount' },
      { phone: value, recipientName: value }
    );
    return amountStepResult(
      next,
      body,
      _ctx,
      'How much should I send?'
    );
  }

  return { reply: 'Please complete the field above.', session };
}

async function handleAmountSubmit(
  session: DayxFlowSession,
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const amount = Number(body.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { reply: 'Enter a valid amount greater than zero.', session };
  }

  const d = data(session);
  const spendCurrency = String(d.spendCurrency ?? 'NGN').toUpperCase();
  const available = balanceFor(ctx.balances, spendCurrency);

  if (amount > available) {
    return {
      reply: `Your ${spendCurrency} balance is ${available.toLocaleString()}. You need ${amount.toLocaleString()} to send. Top up or choose a lower amount.`,
      session: withData(session, { amount }),
      ui: {
        step: 'review',
        title: 'Insufficient balance',
        panel: 'insufficient_balance',
        review: [
          { label: 'Needed', value: `${spendCurrency} ${amount.toLocaleString()}` },
          { label: 'Available', value: `${spendCurrency} ${available.toLocaleString()}` },
        ],
        options: [
          { id: 'top_up', label: 'Top up wallet' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    };
  }

  const next = withData({ ...session, step: 'review' }, { amount });
  const review = reviewLines({ ...d, amount });

  return {
    reply: 'Here’s your transfer summary. Confirm when ready.',
    session: next,
    ui: {
      step: 'review',
      title: 'Review transfer',
      review,
      options: [
        { id: 'confirm', label: 'Confirm & enter PIN' },
        { id: 'cancel', label: 'Cancel' },
      ],
    },
  };
}

function amountStepResult(
  session: DayxFlowSession,
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext,
  reply: string
): Promise<DayxFlowTurnResult> | DayxFlowTurnResult {
  const spend = String(data(session).spendCurrency ?? 'NGN');
  const prefilled = Number(data(session).amount);
  if (Number.isFinite(prefilled) && prefilled > 0) {
    return handleAmountSubmit(
      session,
      { ...body, action: 'submit', value: prefilled },
      ctx
    );
  }
  return { reply, session, ui: amountUi(spend) };
}

function buildExecutePayload(
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
