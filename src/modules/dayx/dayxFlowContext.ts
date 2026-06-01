import type { DayxFlowTurnBody, DayxFlowWalletBalance } from './dayxFlowTypes';

export type DayxFlowContext = {
  userId: string;
  balances: DayxFlowWalletBalance[];
  utterance?: string;
};

export function buildFlowContext(
  userId: string,
  body: DayxFlowTurnBody,
  balances: DayxFlowWalletBalance[]
): DayxFlowContext {
  return {
    userId,
    balances,
    utterance: body.utterance,
  };
}
