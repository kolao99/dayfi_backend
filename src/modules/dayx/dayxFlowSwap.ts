import PaymentService from '../payment/services';
import type { DayxFlowContext } from './dayxFlowContext';
import { buildPinSubmitTurn } from './dayxFlowPin';
import { buildSlotAck, slotsToSessionData, resolveAmountFromSessionData, parseAmountMode } from './dayxFlowSlots';
import { extractFlowSlots } from './dayxSlotExtractor';
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

async function mergeSwapSlots(
  session: DayxFlowSession,
  utterance?: string
): Promise<DayxFlowSession> {
  const slots = await extractFlowSlots(utterance);
  return withData(session, slotsToSessionData(slots, 'swap'));
}

async function advanceSwap(
  session: DayxFlowSession,
  ctx: DayxFlowContext,
  ack?: string
): Promise<DayxFlowTurnResult> {
  const d = data(session);
  const prefix = ack ?? buildSlotAck(d, 'swap');

  if (!d.fromCurrency) {
    const preferred = String(
      d.preferredFromCurrency ?? ''
    ).toUpperCase();
    if (
      preferred &&
      (SWAP_CURRENCIES as readonly string[]).includes(preferred)
    ) {
      return advanceSwap(
        withData({ ...session, step: 'advance' }, { fromCurrency: preferred }),
        ctx,
        prefix
      );
    }
    return {
      reply: prefix
        ? `${prefix} Which wallet are you swapping from?`
        : 'Which wallet are you swapping from? You have NGN, USD, EUR, and GBP.',
      session: { ...session, step: 'select_from' },
      ui: {
        step: 'select_from',
        title: 'Swap from',
        options: walletOptionsFromBalances(ctx.balances),
      },
    };
  }

  const from = String(d.fromCurrency).toUpperCase();

  if (!d.toCurrency) {
    const others = SWAP_CURRENCIES.filter((c) => c !== from);
    return {
      reply: prefix
        ? `${prefix} Which currency do you want?`
        : `Swap from ${from}. Which currency do you want?`,
      session: { ...session, step: 'select_to' },
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

  const to = String(d.toCurrency).toUpperCase();
  const available = balanceFor(ctx.balances, from);
  const resolved = resolveAmountFromSessionData(d, available);

  if (resolved == null) {
    if (d.amountMode === 'max') {
      return {
        reply: prefix
          ? `${prefix} You have no ${from} balance to swap.`
          : `You have no ${from} balance to swap.`,
        session,
      };
    }

    let rateLine = '';
    try {
      const rate = await paymentService.getExchangeRate(from, to);
      if (rate > 0) rateLine = `1 ${from} ≈ ${rate.toFixed(4)} ${to}`;
    } catch {
      rateLine = 'Live rate loads at review';
    }
    return {
      reply: prefix
        ? `${prefix} How much ${from}? Available: ${available.toLocaleString()}.`
        : `How much ${from} do you want to swap? Available: ${available.toLocaleString()}.`,
      session: { ...session, step: 'input_amount' },
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

  return buildSwapReview(session, ctx, resolved, prefix);
}

async function buildSwapReview(
  session: DayxFlowSession,
  ctx: DayxFlowContext,
  amount: number,
  prefix?: string
): Promise<DayxFlowTurnResult> {
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
    if (rate > 0) estimatedTo = (amount * rate).toFixed(2);
  } catch {
    /* optional */
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

  const lead = prefix ? `${prefix} ` : '';
  return {
    reply: `${lead}Swap ${amount} ${from} → ${to}. Rate valid ~30 seconds. Confirm with your PIN.`.trim(),
    session: next,
    ui: {
      step: 'review',
      title: 'Review swap',
      review,
      rateLine: rate > 0 ? `1 ${from} ≈ ${rate.toFixed(4)} ${to}` : undefined,
      options: [
        { id: 'confirm', label: 'Confirm' },
        { id: 'cancel', label: 'Cancel' },
      ],
    },
  };
}

export async function handleSwapFlowTurn(
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  let session: DayxFlowSession = body.session ?? {
    flow: 'swap',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return { reply: 'Swap cancelled.', session: null };
  }

  if (body.action === 'utterance' && body.utterance?.trim()) {
    session = await mergeSwapSlots(session, body.utterance);
    return advanceSwap(session, ctx);
  }

  if (body.action === 'start' || session.step === 'idle') {
    const preferred = String(body.preferredFromCurrency ?? '').toUpperCase();
    let s: DayxFlowSession = { flow: 'swap', step: 'advance', data: {} };
    if (preferred) {
      s = withData(s, { preferredFromCurrency: preferred });
    }
    s = await mergeSwapSlots(s, body.utterance ?? ctx.utterance);
    return advanceSwap(s, ctx);
  }

  if (body.action === 'submit' && body.utterance?.trim()) {
    session = await mergeSwapSlots(session, body.utterance);
    return advanceSwap(session, ctx);
  }

  if (session.step === 'select_from' && body.action === 'select') {
    session = withData({ ...session, step: 'advance' }, {
      fromCurrency: (body.optionId ?? 'USD').toUpperCase(),
    });
    return advanceSwap(session, ctx);
  }

  if (session.step === 'select_to' && body.action === 'select') {
    session = withData({ ...session, step: 'advance' }, {
      toCurrency: (body.optionId ?? 'NGN').toUpperCase(),
    });
    return advanceSwap(session, ctx);
  }

  if (session.step === 'input_amount' && body.action === 'submit') {
    const raw = body.value ?? body.utterance;
    const text = String(raw ?? '').trim();
    const num = Number(String(body.value ?? '').replace(/,/g, ''));
    if (Number.isFinite(num) && num > 0) {
      return buildSwapReview(session, ctx, num);
    }
    if (text) {
      session = await mergeSwapSlots(session, text);
      const d = data(session);
      const from = String(d.fromCurrency ?? 'USD');
      const available = balanceFor(ctx.balances, from);
      const resolved = resolveAmountFromSessionData(d, available);
      if (resolved != null) {
        return buildSwapReview(session, ctx, resolved);
      }
      if (parseAmountMode(text) === 'max') {
        session = withData(session, { amountMode: 'max' });
        const resolvedMax = resolveAmountFromSessionData(
          data(session),
          available
        );
        if (resolvedMax != null) {
          return buildSwapReview(session, ctx, resolvedMax);
        }
      }
    }
    return { reply: 'Enter a valid amount, or say "all" to swap your full balance.', session };
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
    return buildPinSubmitTurn(session, {
      type: 'swap',
      fromCurrency: String(d.fromCurrency),
      toCurrency: String(d.toCurrency),
      amount: Number(d.amount),
    }, pin);
  }

  return advanceSwap(session, ctx);
}
