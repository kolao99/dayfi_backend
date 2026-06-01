import type { DayxFlowContext } from './dayxFlowContext';
import { handleAddMoneyFlowTurn } from './dayxFlowAddMoney';
import {
  advanceSend,
  applyMethodSelect,
  buildExecutePayload,
  handleBankSelect,
  handleCountrySelect,
  handleCryptoNetworkSelect,
  handleRecipientFieldSubmit,
  mergeSlotsIntoSendSession,
  submitAmountForReview,
  withData,
} from './dayxFlowSendAdvance';
import { buildPinSubmitTurn } from './dayxFlowPin';
import type {
  DayxFlowExecutePayload,
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
} from './dayxFlowTypes';
function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

export async function handleSendFlowTurn(
  body: DayxFlowTurnBody,
  ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  let session: DayxFlowSession = body.session ?? {
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

  if (body.action === 'utterance' && body.utterance?.trim()) {
    session = await mergeSlotsIntoSendSession(session, body.utterance);
    return advanceSend(session, ctx);
  }

  if (body.action === 'start' || session.step === 'idle') {
    session = await mergeSlotsIntoSendSession(
      { flow: 'send', step: 'advance', data: {} },
      body.utterance ?? ctx.utterance
    );
    return advanceSend(session, ctx);
  }

  if (session.step === 'collect_recipient' && body.action === 'submit') {
    return handleRecipientFieldSubmit(session, body, ctx);
  }

  if (session.step === 'input_amount' && body.action === 'submit') {
    return submitAmountForReview(session, ctx, Number(body.value));
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
    return buildPinSubmitTurn(session, exec, pin, (s) =>
      withData(s, { executeDraft: exec })
    );
  }

  const structuredSubmitSteps = new Set([
    'collect_recipient',
    'input_amount',
    'collect_pin',
  ]);
  if (
    body.action === 'submit' &&
    body.utterance?.trim() &&
    !structuredSubmitSteps.has(session.step)
  ) {
    session = await mergeSlotsIntoSendSession(session, body.utterance);
    return advanceSend(session, ctx);
  }

  if (session.step === 'select_spend_wallet' && body.action === 'select') {
    const spendCurrency = (body.optionId ?? 'NGN').toUpperCase();
    session = withData({ ...session, step: 'advance' }, { spendCurrency });
    return advanceSend(session, ctx);
  }

  if (session.step === 'select_country' && body.action === 'select') {
    return handleCountrySelect(session, body.optionId ?? '', ctx);
  }

  if (session.step === 'select_method' && body.action === 'select') {
    return applyMethodSelect(session, body.optionId ?? 'bank', ctx);
  }

  if (session.step === 'select_bank' && body.action === 'select') {
    return handleBankSelect(session, body.optionId ?? '', ctx);
  }

  if (session.step === 'select_crypto_network' && body.action === 'select') {
    return handleCryptoNetworkSelect(session, body.optionId ?? 'stellar', ctx);
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

  if (session.step === 'advance' || !session.step) {
    return advanceSend(session, ctx);
  }

  return {
    reply: 'Choose an option above or say cancel.',
    session,
  };
}
