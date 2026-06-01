import { buildFlowContext } from './dayxFlowContext';
import { handleAddMoneyFlowTurn, handlePayFlowTurn } from './dayxFlowMisc';
import { handleSendFlowTurn } from './dayxFlowSend';
import { handleSwapFlowTurn } from './dayxFlowSwap';
import type { DayxFlowTurnBody, DayxFlowTurnResult } from './dayxFlowTypes';
import { loadUserWalletBalances } from './dayxFlowWallets';

export type { DayxFlowTurnBody, DayxFlowTurnResult, DayxFlowSession } from './dayxFlowTypes';

export async function processDayxFlowTurn(
  userId: string,
  body: DayxFlowTurnBody
): Promise<DayxFlowTurnResult> {
  const balances = await loadUserWalletBalances(userId, body.walletBalances);
  const ctx = buildFlowContext(userId, body, balances);

  switch (body.flow) {
    case 'send':
      return handleSendFlowTurn(body, ctx);
    case 'swap':
      return handleSwapFlowTurn(body, ctx);
    case 'pay':
      return handlePayFlowTurn(body, ctx);
    case 'add_money':
      return handleAddMoneyFlowTurn(body, ctx);
    default:
      return {
        reply: 'Unknown flow.',
        session: null,
      };
  }
}
