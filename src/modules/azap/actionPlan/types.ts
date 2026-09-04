/** Canonical Azap ActionPlan — LLM proposes; backend validates & executes. */

export const AZAP_MAX_ACTIONS = 4;

export type AzapActionType =
  | 'create_wallet'
  | 'set_transaction_pin'
  | 'bank_transfer'
  | 'crypto_transfer'
  | 'crypto_deposit'
  | 'crypto_buy'
  | 'crypto_sell'
  | 'crypto_swap'
  | 'fiat_funding'
  | 'fiat_withdrawal'
  | 'airtime_purchase'
  | 'data_purchase'
  | 'bill_payment'
  | 'balance_check'
  | 'rate_check'
  | 'statement_request'
  | 'save_recipient'
  | 'save_biller'
  | 'kyc'
  | 'support'
  | 'consent_review'
  | 'pricing_request';

export type AzapActionStatus =
  | 'draft'
  | 'needs_resolution'
  | 'ready'
  | 'awaiting_review'
  | 'awaiting_confirmation'
  | 'awaiting_pin'
  | 'authorized'
  | 'processing'
  | 'pending'
  | 'succeeded'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'reversed';

export type AzapAction = {
  id: string;
  type: AzapActionType;
  status: AzapActionStatus;
  amount?: string | null;
  currency?: string | null;
  recipientReference?: string | null;
  phoneReference?: string | null;
  billerReference?: string | null;
  asset?: string | null;
  network?: string | null;
  resolvedEntityId?: string | null;
  providerTransactionId?: string | null;
  errorMessage?: string | null;
  slots?: Record<string, unknown>;
};

export type AzapActionPlan = {
  id: string;
  conversationId: string;
  userId: string;
  actions: AzapAction[];
  requiresResolution: boolean;
  requiresConfirmation: boolean;
  requiresPin: boolean;
  batchStatus?:
    | 'open'
    | 'awaiting_review'
    | 'awaiting_pin'
    | 'processing'
    | 'completed'
    | 'partially_completed'
    | 'failed'
    | 'cancelled';
  createdAt: string;
  updatedAt: string;
};

export function createEmptyActionPlan(input: {
  id: string;
  conversationId: string;
  userId: string;
}): AzapActionPlan {
  const now = new Date().toISOString();
  return {
    id: input.id,
    conversationId: input.conversationId,
    userId: input.userId,
    actions: [],
    requiresResolution: false,
    requiresConfirmation: false,
    requiresPin: false,
    batchStatus: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

export function assertActionPlanLimits(plan: AzapActionPlan): {
  ok: boolean;
  reason?: string;
} {
  if (plan.actions.length > AZAP_MAX_ACTIONS) {
    return {
      ok: false,
      reason: `Azap supports up to ${AZAP_MAX_ACTIONS} actions in one request for now.`,
    };
  }
  return { ok: true };
}

export function summarizeActionPlanForReview(plan: AzapActionPlan): string {
  const lines = plan.actions.map((a, i) => {
    const amount = a.amount
      ? a.currency === 'NGN' || !a.currency
        ? `₦${Number(a.amount).toLocaleString('en-NG')}`
        : `${a.amount} ${a.currency}`
      : '';
    const target =
      a.recipientReference ||
      a.billerReference ||
      a.phoneReference ||
      a.asset ||
      a.type;
    return `${i + 1}. ${amount ? `${amount} → ` : ''}${target}`;
  });
  return (
    `I found ${plan.actions.length} request${plan.actions.length === 1 ? '' : 's'}:\n\n` +
    lines.join('\n') +
    `\n\nReady to continue?`
  );
}

export function summarizePartialFailure(plan: AzapActionPlan): string {
  const succeeded = plan.actions.filter((a) => a.status === 'succeeded');
  const failed = plan.actions.filter(
    (a) => a.status === 'failed' || a.status === 'cancelled'
  );
  const lines = plan.actions.map((a) => {
    const mark =
      a.status === 'succeeded' ? '✓' : a.status === 'failed' ? '✗' : '•';
    const detail =
      a.errorMessage ||
      a.recipientReference ||
      a.billerReference ||
      a.phoneReference ||
      a.type;
    return `${mark} ${detail}`;
  });
  return (
    `${succeeded.length} of ${plan.actions.length} payments were completed successfully.\n\n` +
    lines.join('\n') +
    (failed.length
      ? `\n\nFailed actions were not treated as successful.`
      : '')
  );
}
