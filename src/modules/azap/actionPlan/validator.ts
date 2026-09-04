import type { AzapAction, AzapActionPlan } from './types';
import { assertActionPlanLimits } from './types';

/**
 * Deterministic validation boundary.
 * Does not call providers yet — marks resolution / PIN / confirmation flags.
 * Money truth stays in Dayfi services when the executor runs.
 */
export type ActionPlanValidation = {
  ok: boolean;
  plan: AzapActionPlan;
  missingFields: string[];
  reasons: string[];
};

function actionNeedsResolution(action: AzapAction): boolean {
  if (
    action.type === 'bank_transfer' &&
    !action.resolvedEntityId &&
    action.recipientReference
  ) {
    return true;
  }
  if (
    (action.type === 'bill_payment' ||
      action.type === 'airtime_purchase' ||
      action.type === 'data_purchase') &&
    !action.resolvedEntityId &&
    (action.billerReference || action.phoneReference)
  ) {
    return true;
  }
  if (
    (action.type === 'bank_transfer' ||
      action.type === 'airtime_purchase' ||
      action.type === 'bill_payment') &&
    (action.amount == null || action.amount === '')
  ) {
    return true;
  }
  return false;
}

function actionRequiresPin(action: AzapAction): boolean {
  return [
    'bank_transfer',
    'crypto_transfer',
    'crypto_buy',
    'crypto_sell',
    'crypto_swap',
    'fiat_withdrawal',
    'airtime_purchase',
    'data_purchase',
    'bill_payment',
  ].includes(action.type);
}

export function validateActionPlan(plan: AzapActionPlan): ActionPlanValidation {
  const limits = assertActionPlanLimits(plan);
  const reasons: string[] = [];
  const missingFields: string[] = [];

  if (!limits.ok) {
    reasons.push(limits.reason || 'Too many actions');
    return { ok: false, plan, missingFields, reasons };
  }

  let requiresResolution = false;
  let requiresPin = false;

  const actions = plan.actions.map((action) => {
    const next = { ...action };
    if (actionNeedsResolution(next)) {
      requiresResolution = true;
      next.status = 'needs_resolution';
      if (!next.amount) missingFields.push(`${next.id}.amount`);
      if (next.type === 'bank_transfer' && !next.resolvedEntityId) {
        missingFields.push(`${next.id}.recipient`);
      }
    } else if (next.status === 'draft' || next.status === 'needs_resolution') {
      next.status = 'ready';
    }
    if (actionRequiresPin(next)) requiresPin = true;
    return next;
  });

  const nextPlan: AzapActionPlan = {
    ...plan,
    actions,
    requiresResolution,
    requiresConfirmation: requiresPin || actions.length > 0,
    requiresPin,
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: reasons.length === 0,
    plan: nextPlan,
    missingFields,
    reasons,
  };
}
