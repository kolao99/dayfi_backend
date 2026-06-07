/**
 * Map Yellow Card provider status → wallet_transactions status.
 * @see https://docs.yellowcard.engineering/docs/events-api
 * Dashboard values: Complete, Pending_provider, Failed, etc.
 */
export function mapYellowCardProviderStatus(status: unknown): string {
  const s = String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');

  if (!s) return 'pending-payment';

  if (
    s === 'complete' ||
    s === 'completed' ||
    s.includes('settlement-complete') ||
    s.includes('settlement_complete')
  ) {
    return 'success-payment';
  }

  if (
    s.includes('fail') ||
    s.includes('reject') ||
    s.includes('cancel') ||
    s.includes('declin') ||
    s.includes('expired') ||
    s.includes('refund-failed')
  ) {
    return 'failed-payment';
  }

  if (
    s.includes('complete') ||
    s.includes('success') ||
    s.includes('settled') ||
    s === 'paid'
  ) {
    return 'success-payment';
  }

  if (
    s.includes('pending') ||
    s.includes('processing') ||
    s.includes('process') ||
    s.includes('queued') ||
    s.includes('submitted') ||
    s.includes('progress') ||
    s.includes('approval') ||
    s.includes('liquidity') ||
    s === 'created'
  ) {
    return 'pending-payment';
  }

  return 'pending-payment';
}

export function resolveYellowCardPaymentStatus(payment: unknown): string {
  if (!payment || typeof payment !== 'object') return 'pending-payment';
  const p = payment as Record<string, unknown>;
  const nested =
    p.payment && typeof p.payment === 'object'
      ? (p.payment as Record<string, unknown>)
      : null;
  const status =
    p.status ??
    p.state ??
    p.paymentStatus ??
    nested?.status ??
    nested?.state;
  return mapYellowCardProviderStatus(status);
}
