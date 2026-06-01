import PaymentService from '../payment/services';
import type { DayxFlowWalletBalance } from './dayxFlowTypes';

const CORE_CURRENCIES = ['NGN', 'USD', 'EUR', 'GBP'] as const;
const paymentService = new PaymentService();

export function walletOptionsFromBalances(
  balances: DayxFlowWalletBalance[]
): { id: string; label: string; subtitle: string }[] {
  const map = new Map(
    balances.map((b) => [b.currency.toUpperCase(), b.balance])
  );
  return CORE_CURRENCIES.map((c) => {
    const bal = map.get(c) ?? 0;
    return {
      id: c,
      label: c,
      subtitle: `Balance ${bal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
    };
  });
}

export async function loadUserWalletBalances(
  userId: string,
  clientBalances?: DayxFlowWalletBalance[]
): Promise<DayxFlowWalletBalance[]> {
  if (clientBalances?.length) {
    return clientBalances;
  }
  const rows = await paymentService.getWalletsByUserId(userId);
  const list = Array.isArray(rows) ? rows : [];
  const out: DayxFlowWalletBalance[] = [];
  for (const c of CORE_CURRENCIES) {
    const row = list.find(
      (w: Record<string, unknown>) =>
        String(w.currency ?? w.wallet_currency ?? '').toUpperCase() === c
    );
    const bal = Number(
      row?.balance ?? row?.available_balance ?? row?.ledger_balance ?? 0
    );
    out.push({ currency: c, balance: Number.isFinite(bal) ? bal : 0 });
  }
  return out;
}

export function balanceFor(
  balances: DayxFlowWalletBalance[],
  currency: string
): number {
  const c = currency.toUpperCase();
  return balances.find((b) => b.currency.toUpperCase() === c)?.balance ?? 0;
}
