import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
} from './dayxFlowTypes';

const SWAP_CURRENCIES = ['USD', 'NGN', 'GBP', 'EUR'] as const;

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

function withData(
  session: DayxFlowSession,
  patch: Record<string, unknown>
): DayxFlowSession {
  return { ...session, data: { ...data(session), ...patch } };
}

export function handleSwapFlowTurn(body: DayxFlowTurnBody): DayxFlowTurnResult {
  const session: DayxFlowSession = body.session ?? {
    flow: 'swap',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return { reply: 'Swap cancelled.', session: null };
  }

  if (body.action === 'start' || session.step === 'idle') {
    return {
      reply: 'Which wallet are you swapping from?',
      session: { flow: 'swap', step: 'select_from', data: {} },
      ui: {
        step: 'select_from',
        title: 'From',
        options: SWAP_CURRENCIES.map((c) => ({
          id: c,
          label: c,
          subtitle: 'Your balance',
        })),
      },
    };
  }

  if (session.step === 'select_from' && body.action === 'select') {
    const from = (body.optionId ?? 'USD').toUpperCase();
    const others = SWAP_CURRENCIES.filter((c) => c !== from);
    return {
      reply: `Swap from ${from}. Which currency do you want?`,
      session: withData({ ...session, step: 'select_to' }, { fromCurrency: from }),
      ui: {
        step: 'select_to',
        title: 'To',
        options: others.map((c) => ({ id: c, label: c })),
        showBack: true,
      },
    };
  }

  if (session.step === 'select_to' && body.action === 'select') {
    const to = (body.optionId ?? 'NGN').toUpperCase();
    const from = String(data(session).fromCurrency ?? 'USD');
    return {
      reply: `How much ${from} do you want to swap to ${to}?`,
      session: withData({ ...session, step: 'input_amount' }, { toCurrency: to }),
      ui: {
        step: 'input_amount',
        title: 'Amount',
        input: {
          type: 'amount',
          field: 'amount',
          label: `Amount in ${from}`,
          placeholder: '0.00',
          keyboard: 'number',
        },
        showBack: true,
      },
    };
  }

  if (session.step === 'input_amount' && body.action === 'submit') {
    const amount = Number(body.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { reply: 'Enter a valid amount.', session };
    }
    const from = String(data(session).fromCurrency ?? 'USD');
    const to = String(data(session).toCurrency ?? 'NGN');
    const next = withData({ ...session, step: 'review' }, { amount });

    return {
      reply: `Swap ${amount} ${from} → ${to}. Confirm with your PIN.`,
      session: next,
      ui: {
        step: 'review',
        title: 'Review swap',
        review: [
          { label: 'From', value: `${amount} ${from}` },
          { label: 'To', value: to },
        ],
        options: [
          { id: 'confirm', label: 'Confirm & enter PIN' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
      execute: {
        type: 'swap',
        fromCurrency: from,
        toCurrency: to,
        amount,
      },
    };
  }

  if (session.step === 'review' && body.action === 'select') {
    if (body.optionId === 'cancel') {
      return { reply: 'Swap cancelled.', session: null };
    }
    if (body.optionId === 'confirm') {
      const d = data(session);
      return {
        reply: 'Enter your transaction PIN to swap.',
        session,
        awaitingPin: true,
        execute: {
          type: 'swap',
          fromCurrency: String(d.fromCurrency),
          toCurrency: String(d.toCurrency),
          amount: Number(d.amount),
        },
      };
    }
  }

  return { reply: 'Choose an option to continue.', session };
}
