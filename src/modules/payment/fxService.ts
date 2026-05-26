import { db } from '../../config/database';
import { PRIMARY_CURRENCY } from './walletModel';

export async function convertAmountToUsd(
  amount: number,
  fromCurrency: string
): Promise<{ usdAmount: number; rate: number | null }> {
  const from = String(fromCurrency || '')
    .trim()
    .toUpperCase();
  const normalized = Number(amount);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error('Invalid inflow amount');
  }
  if (from === PRIMARY_CURRENCY) {
    return { usdAmount: normalized, rate: 1 };
  }

  const row = await db.oneOrNone<{ rate: string | number }>(
    `SELECT rate FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2`,
    [from, PRIMARY_CURRENCY]
  );
  if (!row?.rate) {
    throw new Error(
      `No exchange rate configured from ${from} to ${PRIMARY_CURRENCY}`
    );
  }
  const rate = Number(row.rate);
  return {
    usdAmount: Number((normalized * rate).toFixed(2)),
    rate,
  };
}

export async function convertAmountBetween(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<{ amount: number; rate: number | null }> {
  const from = String(fromCurrency).trim().toUpperCase();
  const to = String(toCurrency).trim().toUpperCase();
  const normalized = Number(amount);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error('Invalid inflow amount');
  }
  if (from === to) {
    return { amount: normalized, rate: 1 };
  }

  const row = await db.oneOrNone<{ rate: string | number }>(
    `SELECT rate FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2`,
    [from, to]
  );
  if (!row?.rate) {
    throw new Error(`No exchange rate configured from ${from} to ${to}`);
  }
  const rate = Number(row.rate);
  return { amount: Number((normalized * rate).toFixed(2)), rate };
}

/** Sum all wallet balances into USD equivalent (PRD home total). */
export async function sumBalancesToUsd(
  wallets: Array<{ currency: string; balance: number }>
): Promise<number> {
  let total = 0;
  for (const w of wallets) {
    const cur = String(w.currency).toUpperCase();
    const bal = Number(w.balance ?? 0);
    if (cur === PRIMARY_CURRENCY) {
      total += bal;
    } else {
      const { usdAmount } = await convertAmountToUsd(bal, cur);
      total += usdAmount;
    }
  }
  return Number(total.toFixed(2));
}
