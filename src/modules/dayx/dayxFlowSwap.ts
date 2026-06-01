import PaymentService from '../payment/services';
import type { DayxFlowContext } from './dayxFlowContext';
import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
} from './dayxFlowTypes';
import { balanceFor, walletOptionsFromBalances } from './dayxFlowWallets';

const paymentService = new PaymentService();
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

export async function handleSwapFlowTurn(
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const session: DayxFlowSession = body.session ?? {
    flow: 'swap',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return { reply: 'Swap cancelled.', session: null };
  }

  if (body.action === 'start' || session.step === 'idle') {
    const preferred = String(
      body.preferredFromCurrency ?? data(session).preferredFromCurrency ?? ''
    ).toUpperCase();
    if (
      preferred &&
      (['USD', 'NGN', 'GBP', 'EUR'] as const).includes(
        preferred as 'USD' | 'NGN' | 'GBP' | 'EUR'
      )
    ) {
      const others = SWAP_CURRENCIES.filter((c) => c !== preferred);
      return {
        reply: `Swap from your ${preferred} wallet. Which currency do you want?`,
        session: withData(
          { flow: 'swap', step: 'select_to', data: {} },
          { fromCurrency: preferred }
        ),
        ui: {
          step: 'select_to',
          title: 'Swap to',
          options: others.map((c) => {
            const bal = balanceFor(ctx.balances, c);
            return { id: c, label: c, subtitle: `Balance ${bal.toLocaleString()}` };
          }),
          showBack: true,
        },
      };
    }

    return {
      reply: 'Which wallet are you swapping from? You have NGN, USD, EUR, and GBP.',
      session: { flow: 'swap', step: 'select_from', data: {} },
      ui: {
        step: 'select_from',
        title: 'Swap from',
        options: walletOptionsFromBalances(ctx.balances),
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
        title: 'Swap to',
        options: others.map((c) => {
          const bal = balanceFor(ctx.balances, c);
          return {
            id: c,
            label: c,
            subtitle: `Balance ${bal.toLocaleString()}`,
          };
        }),
        showBack: true,
      },
    };
  }

  if (session.step === 'select_to' && body.action === 'select') {
    const to = (body.optionId ?? 'NGN').toUpperCase();
    const from = String(data(session).fromCurrency ?? 'USD');
    let rateLine = '';
    try {
      const rate = await paymentService.getExchangeRate(from, to);
      if (rate > 0) {
        rateLine = `1 ${from} ≈ ${rate.toFixed(4)} ${to}`;
      }
    } catch {
      rateLine = 'Live rate loads at review';
    }
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
        rateLine,
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
    const available = balanceFor(ctx.balances, from);

    if (amount > available) {
      return {
        reply: `Insufficient ${from} balance. You have ${available.toLocaleString()}.`,
        session,
        ui: {
          step: 'review',
          title: 'Insufficient balance',
          panel: 'insufficient_balance',
          review: [
            { label: 'Needed', value: `${from} ${amount}` },
            { label: 'Available', value: `${from} ${available}` },
          ],
          options: [
            { id: 'top_up', label: 'Top up wallet' },
            { id: 'cancel', label: 'Cancel' },
          ],
        },
      };
    }

    let rate = 0;
    let estimatedTo = '';
    try {
      rate = await paymentService.getExchangeRate(from, to);
      if (rate > 0) {
        estimatedTo = (amount * rate).toFixed(2);
      }
    } catch {
      /* rate optional */
    }

    const next = withData({ ...session, step: 'review' }, { amount, rate });
    const review = [
      { label: 'From', value: `${amount} ${from}` },
      { label: 'To', value: to },
      ...(estimatedTo
        ? [{ label: 'You receive ≈', value: `${estimatedTo} ${to}` }]
        : []),
      ...(rate > 0
        ? [{ label: 'Rate', value: `1 ${from} = ${rate.toFixed(4)} ${to}` }]
        : []),
    ];

    return {
      reply: `Swap ${amount} ${from} → ${to}. Confirm with your PIN.`,
      session: next,
      ui: {
        step: 'review',
        title: 'Review swap',
        review,
        rateLine: rate > 0 ? `1 ${from} ≈ ${rate.toFixed(4)} ${to}` : undefined,
        options: [
          { id: 'confirm', label: 'Confirm & enter PIN' },
          { id: 'cancel', label: 'Cancel' },
        ],
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
        session: { ...session, step: 'collect_pin' },
        awaitingPin: true,
        execute: {
          type: 'swap',
          fromCurrency: String(d.fromCurrency),
          toCurrency: String(d.toCurrency),
          amount: Number(d.amount),
        },
        ui: {
          step: 'collect_pin',
          title: 'Transaction PIN',
          input: {
            type: 'pin',
            field: 'pin',
            label: '4-digit PIN',
            keyboard: 'number',
          },
        },
      };
    }
  }

  if (session.step === 'collect_pin' && body.action === 'submit') {
    const pin = String(body.value ?? '').trim();
    const d = data(session);
    if (pin.length < 4) {
      return { reply: 'Enter your 4-digit PIN.', session };
    }
    return {
      reply: 'Processing swap…',
      session: null,
      awaitingPin: true,
      execute: {
        type: 'swap',
        fromCurrency: String(d.fromCurrency),
        toCurrency: String(d.toCurrency),
        amount: Number(d.amount),
        pin,
      },
      completed: true,
    };
  }

  return { reply: 'Choose an option to continue.', session };
}
