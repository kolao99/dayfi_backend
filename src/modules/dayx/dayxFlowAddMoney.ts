import type { DayxFlowContext } from './dayxFlowContext';
import { depositPanel } from './dayxFlowMisc';
import { buildSlotAck, slotsToSessionData } from './dayxFlowSlots';
import { extractFlowSlots } from './dayxSlotExtractor';
import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
} from './dayxFlowTypes';
import { walletOptionsFromBalances } from './dayxFlowWallets';

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

function withData(
  session: DayxFlowSession,
  patch: Record<string, unknown>
): DayxFlowSession {
  return { ...session, data: { ...data(session), ...patch } };
}

async function mergeAddMoneySlots(
  session: DayxFlowSession,
  utterance?: string
): Promise<DayxFlowSession> {
  const slots = await extractFlowSlots(utterance);
  return withData(session, slotsToSessionData(slots, 'add_money'));
}

function showDeposit(
  session: DayxFlowSession,
  method: string,
  ack: string
): DayxFlowTurnResult {
  const currency = String(data(session).currency ?? 'USD').toUpperCase();
  const panel = depositPanel(currency);
  const tab =
    method === 'username' ? 'username' : method === 'crypto' ? 'crypto' : 'bank';

  const titles: Record<string, string> = {
    username: 'Receive via username',
    bank: 'Bank transfer',
    crypto: 'On-chain deposit',
  };

  const replies: Record<string, string> = {
    username: 'Share your username so they can pay you on DayFi.',
    bank: 'Use these bank details to wire or transfer in.',
    crypto: 'Send USDC or EURC on-chain to this address.',
  };

  return {
    reply: ack ? `${ack} ${replies[method] ?? replies.bank}` : replies[method] ?? '',
    session: {
      flow: 'add_money',
      step: 'show_deposit',
      data: { ...session.data, depositTab: tab, depositMethod: method },
    },
    ui: {
      step: 'show_deposit',
      title: titles[method] ?? 'Add money',
      panel: 'deposit',
      deposit: { ...panel, tabs: [tab] },
      options: _continueOptions(session),
    },
  };
}

function advanceAddMoney(
  session: DayxFlowSession,
  ctx: DayxFlowContext,
  ack?: string
): DayxFlowTurnResult | Promise<DayxFlowTurnResult> {
  const d = data(session);
  const prefix = ack ?? buildSlotAck(d, 'add_money');

  const currency = (d.currency as string | undefined)?.toUpperCase();
  const method = d.depositMethod as string | undefined;

  if (!currency) {
    return {
      reply: prefix
        ? `${prefix} Which wallet do you want to fund?`
        : 'Which wallet do you want to fund? NGN, USD, EUR, or GBP.',
      session: { ...session, step: 'select_wallet' },
      ui: {
        step: 'select_wallet',
        title: 'Add money',
        options: walletOptionsFromBalances(ctx.balances),
      },
    };
  }

  const cur = String(currency).toUpperCase();

  if (!method) {
    return {
      reply: prefix
        ? `${prefix} How do you want to fund your ${cur} wallet?`
        : `How do you want to fund your ${cur} wallet?`,
      session: {
        flow: 'add_money',
        step: 'select_deposit_method',
        data: session.data,
      },
      ui: {
        step: 'select_deposit_method',
        title: `Add ${cur}`,
        options: _depositMethodOptions(cur),
        showBack: true,
      },
    };
  }

  return showDeposit(session, method, prefix);
}

export function handleAddMoneyFlowTurn(
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> | DayxFlowTurnResult {
  let session: DayxFlowSession = body.session ?? {
    flow: 'add_money',
    step: 'idle',
    data: {},
  };

  if (body.action === 'utterance' && body.utterance?.trim()) {
    return mergeAddMoneySlots(session, body.utterance).then((s) =>
      advanceAddMoney(s, ctx)
    );
  }

  if (body.action === 'cancel') {
    const parent = data(session).resumeParent as DayxFlowSession | undefined;
    if (parent) {
      return {
        reply: 'Back to your previous task.',
        session: parent,
      };
    }
    return { reply: 'Cancelled.', session: null };
  }

  if (body.action === 'start' || session.step === 'idle') {
    const resumeParent = session.data?.resumeParent;
    const presetCurrency = session.data?.currency;
    return mergeAddMoneySlots(
      {
        flow: 'add_money',
        step: 'advance',
        data: {
          ...(resumeParent ? { resumeParent } : {}),
          ...(presetCurrency ? { currency: presetCurrency } : {}),
        },
      },
      body.utterance ?? ctx.utterance
    ).then((s) => advanceAddMoney(s, ctx));
  }

  if (body.action === 'submit' && body.utterance?.trim()) {
    return mergeAddMoneySlots(session, body.utterance).then((s) =>
      advanceAddMoney(s, ctx)
    );
  }

  if (session.step === 'select_wallet' && body.action === 'select') {
    const currency = (body.optionId ?? 'USD').toUpperCase();
    session = withData({ ...session, step: 'advance' }, { currency });
    return advanceAddMoney(session, ctx);
  }

  if (session.step === 'select_deposit_method' && body.action === 'select') {
    const currency = String(data(session).currency ?? 'USD').toUpperCase();
    const method = body.optionId ?? 'username';
    session = withData(
      { flow: 'add_money', step: 'advance', data: { ...session.data, currency } },
      { depositMethod: method }
    );
    return showDeposit(session, method, buildSlotAck(data(session), 'add_money'));
  }

  if (session.step === 'show_deposit' && body.action === 'select') {
    const parent = data(session).resumeParent as DayxFlowSession | undefined;
    if (body.optionId === 'resume' && parent) {
      return {
        reply: "Great — let's continue where we left off.",
        session: parent,
      };
    }
    return {
      reply: 'Anything else I can help with?',
      session: null,
      completed: true,
    };
  }

  return advanceAddMoney(session, ctx);
}

function _depositMethodOptions(currency: string) {
  const c = currency.toUpperCase();
  const opts = [
    {
      id: 'username',
      label: 'Dayfi username',
      subtitle: 'Receive from another Dayfi user — instant',
    },
    {
      id: 'bank',
      label: 'Bank transfer',
      subtitle: c === 'NGN' ? 'Virtual account' : 'Wire / IBAN (Grey)',
    },
  ];
  if (c === 'USD' || c === 'EUR') {
    opts.push({
      id: 'crypto',
      label: 'On-chain',
      subtitle: c === 'EUR' ? 'EURC on Stellar or Ethereum' : 'USDC on Stellar or Ethereum',
    });
  }
  return opts;
}

function _continueOptions(session: DayxFlowSession) {
  const parent = data(session).resumeParent;
  if (parent) {
    return [
      { id: 'resume', label: 'Continue previous task' },
      { id: 'done', label: 'Done' },
    ];
  }
  return [{ id: 'done', label: 'Done' }];
}
