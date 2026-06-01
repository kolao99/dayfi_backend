import type {
  DayxFlowExecutePayload,
  DayxFlowSession,
  DayxFlowTurnResult,
  DayxFlowUi,
} from './dayxFlowTypes';

export const DAYX_COLLECT_PIN_UI: DayxFlowUi = {
  step: 'collect_pin',
  title: 'Transaction PIN',
  input: {
    type: 'pin',
    field: 'pin',
    label: '4-digit PIN',
    placeholder: '••••',
    keyboard: 'number',
  },
};

/** Keep session + PIN UI after submit so the client can retry on invalid PIN. */
export function buildPinSubmitTurn(
  session: DayxFlowSession,
  execute: DayxFlowExecutePayload,
  pin: string,
  sessionPatch?: (s: DayxFlowSession) => DayxFlowSession
): DayxFlowTurnResult {
  const nextSession = sessionPatch
    ? sessionPatch({ ...session, step: 'collect_pin' })
    : { ...session, step: 'collect_pin' };
  return {
    reply: 'Confirming your transaction…',
    session: nextSession,
    awaitingPin: true,
    execute: { ...execute, pin },
    completed: false,
    ui: DAYX_COLLECT_PIN_UI,
  };
}
