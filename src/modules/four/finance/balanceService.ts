/**
 * Azap balance layer — USDC/USD is the canonical Dayfi ledger balance.
 * NGN/GHS/KES/etc. are valuations via exchange_rates, not separate wallets.
 */
import PaymentService from '../../payment/services';
import {
  formatGlobalDisplayRows,
  formatMoney,
  LOCAL_SPEND_CURRENCY,
  PRIMARY_CURRENCY,
  usdLedgerBalance,
} from '../../payment/walletModel';
import { convertAmountBetween, convertAmountToUsd } from '../../payment/fxService';

const paymentService = new PaymentService();

/** Currencies Azap may quote as valuations (not held balances). */
const VALUATION_ALIASES: Record<string, string> = {
  usdc: 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  naira: 'NGN',
  ngn: 'NGN',
  '₦': 'NGN',
  cedis: 'GHS',
  cedi: 'GHS',
  ghs: 'GHS',
  'gh₵': 'GHS',
  shilling: 'KES',
  shillings: 'KES',
  kes: 'KES',
  rand: 'ZAR',
  zar: 'ZAR',
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  eurc: 'EUR',
  pound: 'GBP',
  pounds: 'GBP',
  gbp: 'GBP',
};

export function normalizeValuationCurrency(raw: string): string | null {
  const q = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9₦₵$€£]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return null;
  if (VALUATION_ALIASES[q]) return VALUATION_ALIASES[q];
  if (/^[a-z]{3}$/.test(q)) return q.toUpperCase();
  return null;
}

/** Detect balance valuation asks: "in naira", "show balance in GHS", etc. */
export function parseBalanceCurrencyHint(text: string): string | null {
  const q = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const looksLikeBalance =
    /\b(balance|wallet|have|worth|value|equivalent|how much)\b/.test(q) ||
    /\bhow much is that\b/.test(q);
  if (!looksLikeBalance) return null;

  const m =
    q.match(
      /\b(?:in|as|as\s+of)\s+(naira|ngn|cedis?|ghs|shillings?|kes|rand|zar|dollars?|usd|usdc|euros?|eur|eurc|pounds?|gbp)\b/
    ) ||
    q.match(
      /\b(naira|ngn|cedis?|ghs|kes|zar|usd|usdc)\s+(?:balance|equivalent|value)\b/
    ) ||
    q.match(
      /\b(?:show|what(?:'s| is)|how much).*(?:balance|have|that).*(?:in|as)\s+(naira|ngn|cedis?|ghs|kes|zar|usd|usdc)\b/
    );
  if (!m) return null;
  return normalizeValuationCurrency(m[1] || m[0]);
}

export async function buildBalanceReply(
  userId: string
): Promise<{ content: string; isEmpty: boolean; failed?: boolean }> {
  try {
    await paymentService.ensureUserLedgerWallets(userId);
    const wallets = await paymentService.getWalletsByUserId(userId);
    const usdBalance = usdLedgerBalance(wallets as any);

    if (usdBalance <= 0) {
      return {
        content:
          'Your wallet balance is *0 USDC*.\n\n' +
          'Fund with crypto (USDC deposit) or NGN bank transfer — your underlying balance stays in USDC.',
        isEmpty: true,
      };
    }

    const rows = await formatGlobalDisplayRows(usdBalance, wallets as any);
    const ngnRow = rows.find((r) => r.currency === LOCAL_SPEND_CURRENCY);
    const usdcLine = `*${usdBalance.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} USDC*`;

    if (ngnRow && ngnRow.balance > 0) {
      return {
        content:
          `Your wallet balance is ${usdcLine}.\n\n` +
          `Estimated NGN value: *${ngnRow.formattedBalance}* _(display only — you hold USDC)._`,
        isEmpty: false,
      };
    }

    return {
      content: `Your wallet balance is ${usdcLine}.`,
      isEmpty: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[azap/balance] lookup failed', msg);
    return {
      content:
        "I couldn't retrieve your wallet balance right now. Please try again in a moment.",
      isEmpty: false,
      failed: true,
    };
  }
}

export async function buildBalanceInCurrencyReply(
  userId: string,
  currencyRaw: string
): Promise<{ content: string; failed?: boolean }> {
  const currency = normalizeValuationCurrency(currencyRaw) || currencyRaw.toUpperCase();
  try {
    await paymentService.ensureUserLedgerWallets(userId);
    const wallets = await paymentService.getWalletsByUserId(userId);
    const usdBalance = usdLedgerBalance(wallets as any);

    if (currency === 'USD' || currency === 'USDC') {
      return {
        content: `Your wallet balance is *${usdBalance.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} USDC*.`,
      };
    }

    const { amount } = await convertAmountBetween(
      usdBalance,
      PRIMARY_CURRENCY,
      currency
    );
    const usdcLine = `${usdBalance.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} USDC`;

    return {
      content:
        `Estimated ${currency} value: *${formatMoney(amount, currency)}*.\n\n` +
        `Underlying wallet balance: *${usdcLine}* _(you do not hold a separate ${currency} balance)._`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[azap/balance] valuation failed', currency, msg);
    if (/No exchange rate/i.test(msg)) {
      return {
        content:
          `I don't have a live ${currency} rate configured right now, so I can't show that equivalent.\n\n` +
          `Ask "What's my balance?" for your USDC wallet balance.`,
        failed: true,
      };
    }
    return {
      content:
        "I couldn't convert your balance right now. Please try again in a moment.",
      failed: true,
    };
  }
}

/** "How much USDC do I need to send ₦10,000?" */
export async function buildSendCostQuoteReply(input: {
  amount: number;
  currency: string;
}): Promise<{ content: string; failed?: boolean }> {
  const currency = normalizeValuationCurrency(input.currency) || 'NGN';
  const amount = Number(input.amount);
  if (!(amount > 0)) {
    return { content: 'Tell me a positive amount to quote.', failed: true };
  }
  try {
    const feeUsd = Number(process.env.DAYFI_TRANSFER_FEE_USD ?? 0.05);
    const { usdAmount: principalUsd } = await convertAmountToUsd(amount, currency);
    const totalUsd = Number((principalUsd + (Number.isFinite(feeUsd) ? feeUsd : 0)).toFixed(2));
    const feeNgn =
      currency === 'NGN'
        ? (
            await convertAmountBetween(
              Number.isFinite(feeUsd) ? feeUsd : 0,
              'USD',
              'NGN'
            )
          ).amount
        : null;

    return {
      content:
        `To send *${formatMoney(amount, currency)}*:\n\n` +
        `• Required from your wallet: ~*${totalUsd.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} USDC*\n` +
        `• Of which principal ≈ ${principalUsd.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} USDC` +
        (feeNgn != null && feeNgn > 0
          ? `\n• Fee ≈ ${formatMoney(feeNgn, 'NGN')}`
          : feeUsd > 0
            ? `\n• Fee ≈ $${feeUsd.toFixed(2)}`
            : '') +
        `\n\n_Rates come from Dayfi exchange rates and can move. Confirm before you send._`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[azap/balance] send cost quote failed', msg);
    return {
      content:
        "I couldn't get a live quote for that amount right now. Please try again shortly.",
      failed: true,
    };
  }
}

export async function estimateTransferFeeNgn(): Promise<number> {
  const feeUsd = Number(process.env.DAYFI_TRANSFER_FEE_USD ?? 0.05);
  if (!Number.isFinite(feeUsd) || feeUsd <= 0) return 0;
  const { amount } = await convertAmountBetween(
    feeUsd,
    'USD',
    LOCAL_SPEND_CURRENCY
  );
  return Math.max(0, Math.round(amount));
}

export async function hasSufficientBalanceForSend(
  userId: string,
  amountNgn: number,
  feeNgn: number
): Promise<boolean> {
  await paymentService.ensureUserLedgerWallets(userId);
  const wallets = await paymentService.getWalletsByUserId(userId);
  const usdBalance = usdLedgerBalance(wallets as any);
  const total = amountNgn + feeNgn;
  const { usdAmount } = await convertAmountToUsd(total, LOCAL_SPEND_CURRENCY);
  return Number(usdBalance) >= Number(usdAmount);
}

export { paymentService };
