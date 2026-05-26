import {
  creditUsdBalance,
  creditWalletBalance,
  buildIdempotencyKey,
  type LedgerSource,
} from './balanceService';
import {
  convertAmountToUsd,
  convertAmountBetween,
} from './fxService';

export type InflowSource = LedgerSource;

export { convertAmountToUsd, convertAmountBetween };

/**
 * Idempotent USD credit — legacy hub path.
 */
export async function creditUsdInflow(params: {
  userId: string;
  usdWalletId: string;
  amount: number;
  fromCurrency: string;
  source: InflowSource;
  externalReference: string;
}): Promise<{
  usdAmount: number;
  rate: number | null;
  duplicate: boolean;
}> {
  const idempotencyKey = buildIdempotencyKey(
    params.source,
    params.externalReference
  );
  const result = await creditUsdBalance({
    userId: params.userId,
    walletId: params.usdWalletId,
    amount: params.amount,
    fromCurrency: params.fromCurrency,
    source: params.source,
    idempotencyKey,
    externalReference: params.externalReference,
  });
  return {
    usdAmount: result.usdAmount,
    rate: result.rate,
    duplicate: result.duplicate,
  };
}

/**
 * Idempotent credit to a specific currency wallet (PRD).
 */
export async function creditWalletInflow(params: {
  userId: string;
  walletId: string;
  targetCurrency: string;
  amount: number;
  fromCurrency: string;
  source: InflowSource;
  externalReference: string;
}): Promise<{
  creditedAmount: number;
  rate: number | null;
  duplicate: boolean;
}> {
  const target = String(params.targetCurrency).toUpperCase();
  const { amount: creditedAmount, rate } = await convertAmountBetween(
    params.amount,
    params.fromCurrency,
    target
  );

  const idempotencyKey = buildIdempotencyKey(
    params.source,
    params.externalReference
  );

  const { usdAmount } = await convertAmountToUsd(creditedAmount, target);

  const result = await creditWalletBalance({
    userId: params.userId,
    walletId: params.walletId,
    amount: creditedAmount,
    currency: target,
    usdEquivalent: usdAmount,
    source: params.source,
    idempotencyKey,
    externalReference: params.externalReference,
    metadata: { fromCurrency: params.fromCurrency, rate },
  });

  return {
    creditedAmount,
    rate,
    duplicate: result.duplicate,
  };
}
