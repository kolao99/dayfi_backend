/** Yellow Card Send limits — local payout currency per transaction. */
export type YellowCardSendLimitRow = {
  country: string;
  currency: string;
  paymentMethod: 'bank_transfer' | 'mobile_money';
  min: number;
  max: number;
};

export const YELLOW_CARD_SEND_LIMITS: YellowCardSendLimitRow[] = [
  { country: 'BJ', currency: 'XOF', paymentMethod: 'mobile_money', min: 500, max: 1_500_000 },
  { country: 'BW', currency: 'BWP', paymentMethod: 'bank_transfer', min: 150, max: 1_000_000 },
  { country: 'BW', currency: 'BWP', paymentMethod: 'mobile_money', min: 150, max: 10_000 },
  { country: 'BF', currency: 'XOF', paymentMethod: 'mobile_money', min: 500, max: 1_500_000 },
  { country: 'CM', currency: 'XAF', paymentMethod: 'mobile_money', min: 1000, max: 1_000_000 },
  { country: 'CG', currency: 'XAF', paymentMethod: 'bank_transfer', min: 1000, max: 1_500_000 },
  { country: 'CD', currency: 'CDF', paymentMethod: 'mobile_money', min: 1000, max: 5_000_000 },
  { country: 'CI', currency: 'XOF', paymentMethod: 'mobile_money', min: 500, max: 1_500_000 },
  { country: 'GA', currency: 'XAF', paymentMethod: 'bank_transfer', min: 1000, max: 10_000_000 },
  { country: 'KE', currency: 'KES', paymentMethod: 'bank_transfer', min: 500, max: 999_999 },
  { country: 'KE', currency: 'KES', paymentMethod: 'mobile_money', min: 150, max: 250_000 },
  { country: 'MW', currency: 'MWK', paymentMethod: 'bank_transfer', min: 5000, max: 20_000_000 },
  { country: 'MW', currency: 'MWK', paymentMethod: 'mobile_money', min: 5000, max: 750_000 },
  { country: 'ML', currency: 'XOF', paymentMethod: 'mobile_money', min: 500, max: 1_500_000 },
  { country: 'NG', currency: 'NGN', paymentMethod: 'bank_transfer', min: 1800, max: 30_000_000 },
  { country: 'NG', currency: 'NGN', paymentMethod: 'mobile_money', min: 1800, max: 30_000_000 },
  { country: 'RW', currency: 'RWF', paymentMethod: 'bank_transfer', min: 1500, max: 10_000_000 },
  { country: 'RW', currency: 'RWF', paymentMethod: 'mobile_money', min: 1500, max: 10_000_000 },
  { country: 'SN', currency: 'XOF', paymentMethod: 'mobile_money', min: 1000, max: 200_000 },
  { country: 'ZA', currency: 'ZAR', paymentMethod: 'bank_transfer', min: 200, max: 500_000 },
  { country: 'TZ', currency: 'TZS', paymentMethod: 'bank_transfer', min: 2500, max: 150_000_000 },
  { country: 'TZ', currency: 'TZS', paymentMethod: 'mobile_money', min: 2500, max: 10_000_000 },
  { country: 'TG', currency: 'XOF', paymentMethod: 'mobile_money', min: 500, max: 1_500_000 },
  { country: 'UG', currency: 'UGX', paymentMethod: 'bank_transfer', min: 15_000, max: 36_000_000 },
  { country: 'UG', currency: 'UGX', paymentMethod: 'mobile_money', min: 15_000, max: 3_000_000 },
  { country: 'ZM', currency: 'ZMW', paymentMethod: 'bank_transfer', min: 100, max: 15_000_000 },
  { country: 'ZM', currency: 'ZMW', paymentMethod: 'mobile_money', min: 100, max: 20_000 },
];

export function resolveYellowCardSendLimit(params: {
  country?: string;
  receiveCurrency?: string;
  channelId?: string;
  networkId?: string;
}): YellowCardSendLimitRow | undefined {
  const country = String(params.country ?? '').trim().toUpperCase();
  const currency = String(params.receiveCurrency ?? '').trim().toUpperCase();
  if (!country || !currency) return undefined;

  const channel = `${params.channelId ?? ''} ${params.networkId ?? ''}`.toLowerCase();
  const paymentMethod: YellowCardSendLimitRow['paymentMethod'] =
    channel.includes('momo') || channel.includes('mobile')
      ? 'mobile_money'
      : 'bank_transfer';

  const exact = YELLOW_CARD_SEND_LIMITS.find(
    (row) =>
      row.country === country &&
      row.currency === currency &&
      row.paymentMethod === paymentMethod,
  );
  if (exact) return exact;

  if (country === 'NG' && currency === 'NGN') {
    return YELLOW_CARD_SEND_LIMITS.find(
      (row) => row.country === 'NG' && row.paymentMethod === 'bank_transfer',
    );
  }

  return undefined;
}

export function assertYellowCardSendWithinLimits(params: {
  country?: string;
  receiveCurrency?: string;
  receiveAmount: number;
  channelId?: string;
  networkId?: string;
}): void {
  const limit = resolveYellowCardSendLimit(params);
  if (!limit) return;

  const amount = Number(params.receiveAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid receive amount');
  }
  if (amount < limit.min) {
    throw new Error(
      `Minimum payout is ${limit.currency} ${limit.min.toLocaleString('en-US')}. Increase your amount and try again.`,
    );
  }
  if (amount > limit.max) {
    throw new Error(
      `Maximum payout is ${limit.currency} ${limit.max.toLocaleString('en-US')}.`,
    );
  }
}
