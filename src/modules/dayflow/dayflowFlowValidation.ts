import type { DayFlowPaymentLine, DayFlowPlanDraft } from './dayflowService';
import type { DayFlowInputCurrency } from './dayflowCurrency';
import { hasResolvableSchedule, resolveNextRunAtIso } from './dayflowDueDate';

export function isValidRecipientOrBillHint(
  hint: string | undefined | null,
  paymentType: string
): boolean {
  const t = String(hint ?? '').trim();
  if (!t) return false;
  if (paymentType === 'savings') return true;

  if (paymentType === 'bill') {
    return /\d{6,}/.test(t.replace(/[\s-]/g, '')) || t.includes('@');
  }

  if (/@([a-zA-Z0-9_]{2,})/.test(t)) return true;

  const compact = t.replace(/[\s\-()]/g, '');
  if (/0[7-9]\d{9}/.test(compact)) return true;
  if (/\+?234[7-9]\d{9}/.test(compact)) return true;

  if (
    /\d{10}/.test(compact) &&
    /bank|gtb|access|uba|zenith|fcmb|stanbic|wema|fidelity|opay|palmpay|kuda|moniepoint|sterling|union/i.test(
      t
    )
  ) {
    return true;
  }

  return t.length >= 8;
}

function paymentTypeForTitle(title: string): string {
  const lower = title.toLowerCase();
  if (
    lower.includes('electric') ||
    lower.includes('data') ||
    lower.includes('airtime') ||
    lower.includes('dstv') ||
    lower.includes('gotv') ||
    lower.includes('bill')
  ) {
    return 'bill';
  }
  if (lower.includes('saving') || lower.includes('emergency')) return 'savings';
  return 'send';
}

function frequencyFromLabel(label?: string | null): string {
  const lower = String(label ?? '').toLowerCase();
  if (
    lower.includes('every week') ||
    lower.includes('each week') ||
    lower.includes('weekly') ||
    lower.includes('per week')
  ) {
    return 'weekly';
  }
  if (lower.includes('two week') || lower.includes('biweekly')) {
    return 'biweekly';
  }
  if (lower.includes('every day') || lower.includes('daily')) return 'daily';
  if (lower.includes('once')) return 'once';
  return 'monthly';
}

function deliversNonUsd(params: {
  toCurrency?: string | null;
  recipientHint?: string | null;
}): boolean {
  const to = String(params.toCurrency ?? '').trim().toUpperCase();
  if (to && to !== 'USD') return true;
  const hint = String(params.recipientHint ?? '').toLowerCase();
  return /opay|palmpay|naira|ngn|mtn|glo|airtel|9mobile|gtb|access|uba|zenith|bank|nigeria/i.test(
    hint
  );
}

function hasDualCurrencyAmounts(params: {
  usdAmount: number;
  inputCurrency: DayFlowInputCurrency;
  sourceAmount?: number;
  toCurrency?: string | null;
  recipientHint?: string | null;
}): boolean {
  if (!(params.usdAmount > 0)) return false;
  const spokeNgn = params.inputCurrency === 'NGN';
  const delivers = deliversNonUsd({
    toCurrency: params.toCurrency,
    recipientHint: params.recipientHint,
  });
  if (!spokeNgn && !delivers) return true;
  return Number(params.sourceAmount) > 0;
}

export function validatePlanDraftForCreate(
  draft: DayFlowPlanDraft
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const inputCurrency = (draft.inputCurrency ?? 'USD') as DayFlowInputCurrency;

  for (const pay of draft.payments) {
    if (!pay.autoSend) continue;
    const label = pay.title?.trim() || 'Payment';
    const paymentType = paymentTypeForTitle(pay.title);

    if (!isValidRecipientOrBillHint(pay.recipientHint, paymentType)) {
      issues.push(`${label}: valid recipient or bill details required`);
    }

    if (!(Number(pay.amount) > 0)) {
      issues.push(`${label}: USD amount must be greater than zero`);
    }

    const toCurrency =
      (pay as DayFlowPaymentLine & { toCurrency?: string }).toCurrency ?? null;
    if (
      !hasDualCurrencyAmounts({
        usdAmount: Number(pay.amount),
        inputCurrency,
        sourceAmount: pay.sourceAmount,
        toCurrency,
        recipientHint: pay.recipientHint,
      })
    ) {
      issues.push(`${label}: include delivery-currency amount (e.g. NGN) and USD`);
    }

    const freq = frequencyFromLabel(pay.dueLabel ?? draft.periodLabel);
    const nextRunAt =
      (pay as DayFlowPaymentLine & { nextRunAt?: string }).nextRunAt ?? null;
    if (
      !hasResolvableSchedule({
        dueLabel: pay.dueLabel ?? draft.periodLabel,
        nextRunAt,
        frequency: freq,
      })
    ) {
      issues.push(`${label}: schedule date/time required`);
    } else if (freq === 'once' && !resolveNextRunAtIso({
      dueLabel: pay.dueLabel ?? draft.periodLabel,
      nextRunAt,
      frequency: freq,
    })) {
      issues.push(`${label}: schedule date/time required`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true };
}

export type FlowScheduleInput = {
  title: string;
  amount: number;
  sourceAmount?: number;
  frequency?: string;
  dueLabel?: string;
  nextRunAt?: string | null;
  recipientHint?: string;
  recipientId?: string | null;
  paymentType?: string;
  autoPay?: boolean;
  execution?: { toCurrency?: string; bill?: Record<string, unknown> };
};

export function validateSchedulesForCreate(
  schedules: FlowScheduleInput[]
): { ok: true } | { ok: false; message: string } {
  for (const s of schedules) {
    if (!s.autoPay) continue;
    const label = s.title?.trim() || 'Payment';
    const paymentType = s.paymentType ?? paymentTypeForTitle(s.title);

    if (!isValidRecipientOrBillHint(s.recipientHint, paymentType)) {
      return {
        ok: false,
        message: `${label}: valid recipient or bill details required`,
      };
    }

    if (!(Number(s.amount) > 0)) {
      return { ok: false, message: `${label}: USD amount must be greater than zero` };
    }

    const toCurrency = s.execution?.toCurrency ?? null;
    const sourceAmount = s.sourceAmount;
    const needsDual = deliversNonUsd({
      toCurrency,
      recipientHint: s.recipientHint,
    });
    if (needsDual && !(Number(sourceAmount) > 0)) {
      return {
        ok: false,
        message: `${label}: include delivery-currency amount (e.g. NGN) and USD`,
      };
    }

    const freq = frequencyFromLabel(s.dueLabel);
    if (
      !hasResolvableSchedule({
        dueLabel: s.dueLabel,
        nextRunAt: s.nextRunAt,
        frequency: freq,
      })
    ) {
      return { ok: false, message: `${label}: schedule date/time required` };
    }

    if (
      paymentType === 'bill' &&
      !s.execution?.bill &&
      !isValidRecipientOrBillHint(s.recipientHint, 'bill')
    ) {
      return { ok: false, message: `${label}: bill account details required` };
    }

    if (
      paymentType === 'send' &&
      !(s.recipientId?.trim() || s.recipientHint?.trim())
    ) {
      return {
        ok: false,
        message: `${label}: recipient required for send autopay`,
      };
    }
  }

  return { ok: true };
}
