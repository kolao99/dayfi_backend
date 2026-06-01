import type { DayxFlowContext } from './dayxFlowContext';
import { depositPanel } from './dayxFlowMisc';
import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
} from './dayxFlowTypes';
import { walletOptionsFromBalances } from './dayxFlowWallets';

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

export function handleAddMoneyFlowTurn(
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> | DayxFlowTurnResult {
  const session: DayxFlowSession = body.session ?? {
    flow: 'add_money',
    step: 'idle',
    data: {},
  };

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
    return {
      reply: 'Which wallet do you want to fund? NGN, USD, EUR, or GBP.',
      session: { flow: 'add_money', step: 'select_wallet', data: session.data },
      ui: {
        step: 'select_wallet',
        title: 'Add money',
        options: walletOptionsFromBalances(ctx.balances),
      },
    };
  }

  if (session.step === 'select_wallet' && body.action === 'select') {
    const currency = (body.optionId ?? 'USD').toUpperCase();
    const methodOptions = _depositMethodOptions(currency);
    return {
      reply: `How do you want to fund your ${currency} wallet?`,
      session: {
        flow: 'add_money',
        step: 'select_deposit_method',
        data: { ...session.data, currency },
      },
      ui: {
        step: 'select_deposit_method',
        title: `Add ${currency}`,
        options: methodOptions,
        showBack: true,
      },
    };
  }

  if (session.step === 'select_deposit_method' && body.action === 'select') {
    const currency = String(data(session).currency ?? 'USD').toUpperCase();
    const method = body.optionId ?? 'username';
    const panel = depositPanel(currency);

    if (method === 'username') {
      return {
        reply: 'Share your username so they can pay you on DayFi.',
        session: {
          flow: 'add_money',
          step: 'show_deposit',
          data: { ...session.data, depositTab: 'username' },
        },
        ui: {
          step: 'show_deposit',
          title: 'Receive via username',
          panel: 'deposit',
          deposit: { ...panel, tabs: ['username'] },
          options: _continueOptions(session),
        },
      };
    }

    if (method === 'bank') {
      return {
        reply: 'Use these bank details to wire or transfer in.',
        session: {
          flow: 'add_money',
          step: 'show_deposit',
          data: { ...session.data, depositTab: 'bank' },
        },
        ui: {
          step: 'show_deposit',
          title: 'Bank transfer',
          panel: 'deposit',
          deposit: { ...panel, tabs: ['bank'] },
          options: _continueOptions(session),
        },
      };
    }

    if (method === 'crypto') {
      return {
        reply: 'Send USDC or EURC on-chain to this address.',
        session: {
          flow: 'add_money',
          step: 'show_deposit',
          data: { ...session.data, depositTab: 'crypto' },
        },
        ui: {
          step: 'show_deposit',
          title: 'On-chain deposit',
          panel: 'deposit',
          deposit: { ...panel, tabs: ['crypto'] },
          options: _continueOptions(session),
        },
      };
    }
  }

  if (session.step === 'show_deposit' && body.action === 'select') {
    const parent = data(session).resumeParent as DayxFlowSession | undefined;
    if (body.optionId === 'resume' && parent) {
      return {
        reply: 'Great — let\'s continue where we left off.',
        session: parent,
      };
    }
    return {
      reply: 'Anything else I can help with?',
      session: null,
      completed: true,
    };
  }

  return { reply: 'Pick a wallet or deposit method.', session };
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
