import { formatMoney } from '../payment/walletModel';

export { formatMoney };

/** Compact rate display: 1 USD ≈ 1,371.3547 NGN */
export function formatExchangeRate(
  from: string,
  to: string,
  rate: number
): string {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return '';
  const formatted = r.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return `1 ${from.toUpperCase()} ≈ ${formatted} ${to.toUpperCase()}`;
}

/** Amount with currency symbol and grouping — e.g. ₦21,941.67 */
export function formatAmount(currency: string, amount: number): string {
  return formatMoney(amount, currency);
}

/** Mask Nigerian account / long numeric identifiers for chat display. */
export function maskSensitiveNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return raw;
  if (digits.length === 10) {
    return `••••${digits.slice(-4)}`;
  }
  if (digits.length > 12) {
    return `${digits.slice(0, 4)}••••${digits.slice(-4)}`;
  }
  return `••••${digits.slice(-4)}`;
}

/** Never echo PINs; normalize copy for in-chat security steps. */
export function pinStepReply(action: string): string {
  return `Reply confirm to ${action}, then enter your 4-digit PIN when prompted.`;
}
