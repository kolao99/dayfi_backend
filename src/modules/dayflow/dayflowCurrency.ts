import { db } from '../../config/database';
import {
  convertAmountToUsd,
  resolveExchangeRate,
} from '../payment/fxService';
import { PRIMARY_CURRENCY } from '../payment/walletModel';
import type { DayFlowPaymentLine, DayFlowPlanDraft } from './dayflowService';
import { resolveNextRunAtIso } from './dayflowDueDate';

export type DayFlowInputCurrency = 'NGN' | 'USD';

export async function loadUsdBalance(userId: string): Promise<number> {
  const row = await db.oneOrNone<{ balance: string }>(
    `SELECT balance::text AS balance FROM wallets
     WHERE user_id = $1 AND currency = $2 LIMIT 1`,
    [userId, PRIMARY_CURRENCY]
  );
  return row ? Number(row.balance) : 0;
}

type AmountLine = { amount: number; sourceAmount?: number };

async function toUsdAmount(
  amount: number,
  inputCurrency: DayFlowInputCurrency
): Promise<AmountLine> {
  const normalized = Number(amount);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return { amount: 0 };
  }
  if (inputCurrency === 'USD') {
    return { amount: normalized };
  }
  const { usdAmount } = await convertAmountToUsd(normalized, 'NGN');
  return { amount: usdAmount, sourceAmount: normalized };
}

function validateRentSplits(
  categories: { name: string; allocated: number; sourceAmount?: number }[],
  payments: DayFlowPaymentLine[],
  readyToApprove: boolean
): boolean {
  if (!readyToApprove) return false;

  const rentCategory = categories.find((c) => /rent/i.test(c.name));
  if (!rentCategory) return readyToApprove;

  const rentPayments = payments.filter((p) => /rent/i.test(p.title));
  if (rentPayments.length === 0) return readyToApprove;

  const paymentSum = rentPayments.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const tolerance = 0.02;
  if (Math.abs(paymentSum - rentCategory.allocated) > tolerance) {
    return false;
  }
  return readyToApprove;
}

/**
 * Canonical DayFlow plans are stored in USD (global wallet ledger).
 * When the user speaks in NGN, preserve sourceAmount on each line for display.
 */
export async function normalizePlanDraftToUsd(
  draft: DayFlowPlanDraft,
  inputCurrency: DayFlowInputCurrency
): Promise<DayFlowPlanDraft> {
  let fxNgnPerUsd: number | undefined;
  if (inputCurrency === 'NGN') {
    fxNgnPerUsd = await resolveExchangeRate('USD', 'NGN');
  }

  const categories = await Promise.all(
    draft.categories.map(async (c) => {
      const converted = await toUsdAmount(c.allocated, inputCurrency);
      return {
        name: c.name,
        allocated: converted.amount,
        ...(converted.sourceAmount != null
          ? { sourceAmount: converted.sourceAmount }
          : {}),
      };
    })
  );

  const payments: DayFlowPaymentLine[] = await Promise.all(
    draft.payments.map(async (p) => {
      const converted = await toUsdAmount(p.amount, inputCurrency);
      const freq = String(p.dueLabel ?? draft.periodLabel ?? '').toLowerCase();
      const frequency =
        freq.includes('week') && !freq.includes('two')
          ? 'weekly'
          : freq.includes('tomorrow') || freq.includes('today') || freq.includes('once')
            ? 'once'
            : 'monthly';
      const resolvedNext = resolveNextRunAtIso({
        dueLabel: p.dueLabel ?? draft.periodLabel,
        nextRunAt: p.nextRunAt,
        frequency,
      });
      return {
        ...p,
        amount: converted.amount,
        ...(converted.sourceAmount != null
          ? { sourceAmount: converted.sourceAmount }
          : p.sourceAmount != null
            ? { sourceAmount: p.sourceAmount }
            : {}),
        ...(resolvedNext ? { nextRunAt: resolvedNext } : {}),
      };
    })
  );

  const totalFromLines =
    categories.reduce((s, c) => s + c.allocated, 0) +
    payments.reduce((s, p) => s + p.amount, 0);
  const totalBase =
    draft.totalBudget > 0 ? draft.totalBudget : totalFromLines;
  const totalConverted = await toUsdAmount(totalBase, inputCurrency);
  const leftoverConverted = await toUsdAmount(draft.leftover, inputCurrency);

  const readyToApprove = validateRentSplits(
    categories,
    payments,
    draft.readyToApprove
  );

  return {
    ...draft,
    totalBudget: totalConverted.amount,
    leftover: leftoverConverted.amount,
    categories,
    payments,
    currency: 'USD',
    inputCurrency,
    fxNgnPerUsd,
    readyToApprove,
  };
}
