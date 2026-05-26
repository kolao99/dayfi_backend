import { db } from '../../config/database';
import { PRIMARY_CURRENCY } from './walletModel';

export type PayoutQuoteInput = {
  amountUsd: number;
  targetCurrency: string;
  feeUsd?: number;
};

export type PayoutQuote = {
  sendAmountUsd: number;
  targetCurrency: string;
  exchangeRate: number;
  beneficiaryReceives: number;
  feeUsd: number;
  estimatedMinutes: number;
};

const DEFAULT_FEE_USD = 0;
const AFRICA_ESTIMATE_MINS = 30;
const BANK_ESTIMATE_MINS = 60;

export async function getPayoutQuote(
  input: PayoutQuoteInput
): Promise<PayoutQuote> {
  const target = String(input.targetCurrency || '')
    .trim()
    .toUpperCase();
  const amountUsd = Number(input.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('Invalid send amount');
  }

  let rate = 1;
  if (target !== PRIMARY_CURRENCY) {
    const row = await db.oneOrNone<{ rate: string | number }>(
      `SELECT rate FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2`,
      [PRIMARY_CURRENCY, target]
    );
    if (!row?.rate) {
      throw new Error(
        `No exchange rate from ${PRIMARY_CURRENCY} to ${target}. Configure via POST /payments/exchange-rate.`
      );
    }
    rate = Number(row.rate);
  }

  const feeUsd = input.feeUsd ?? DEFAULT_FEE_USD;
  const beneficiaryReceives = Number((amountUsd * rate).toFixed(2));
  const isAfricaFiat = !['USD', 'EUR', 'GBP', 'CAD'].includes(target);

  return {
    sendAmountUsd: amountUsd,
    targetCurrency: target,
    exchangeRate: rate,
    beneficiaryReceives,
    feeUsd,
    estimatedMinutes: isAfricaFiat ? AFRICA_ESTIMATE_MINS : BANK_ESTIMATE_MINS,
  };
}
