import { handleAddMoneyFlowTurn, handlePayFlowTurn } from './dayxFlowMisc';
import { handleSendFlowTurn } from './dayxFlowSend';
import { handleSwapFlowTurn } from './dayxFlowSwap';
import type { DayxFlowTurnBody, DayxFlowTurnResult } from './dayxFlowTypes';

export type { DayxFlowTurnBody, DayxFlowTurnResult, DayxFlowSession } from './dayxFlowTypes';

export async function processDayxFlowTurn(
  _userId: string,
  body: DayxFlowTurnBody
): Promise<DayxFlowTurnResult> {
  switch (body.flow) {
    case 'send':
      return handleSendFlowTurn(body);
    case 'swap':
      return handleSwapFlowTurn(body);
    case 'pay':
      return handlePayFlowTurn(body);
    case 'add_money':
      return handleAddMoneyFlowTurn(body);
    default:
      return {
        reply: 'Unknown flow.',
        session: null,
      };
  }
}
