import PaymentService from '../../payment/services';
import {
  formatGlobalDisplayRows,
  formatMoney,
  LOCAL_SPEND_CURRENCY,
  usdLedgerBalance,
} from '../../payment/walletModel';

const paymentService = new PaymentService();

export async function buildBalanceReply(userId: string): Promise<string> {
  await paymentService.ensureUserLedgerWallets(userId);
  const wallets = await paymentService.getWalletsByUserId(userId);
  const usdBalance = usdLedgerBalance(wallets as any);
  const rows = await formatGlobalDisplayRows(usdBalance, wallets as any);
  const ngnRow = rows.find((r) => r.currency === LOCAL_SPEND_CURRENCY);

  if (!ngnRow || ngnRow.balance <= 0) {
    if (usdBalance <= 0) {
      return "You don't have any balance yet. Fund your wallet to get started.";
    }
    const usdFormatted = formatMoney(usdBalance, 'USD');
    return `You have ${usdFormatted} available.`;
  }

  return `You have ${ngnRow.formattedBalance} available.`;
}

export async function estimateTransferFeeNgn(): Promise<number> {
  const feeUsd = Number(process.env.DAYFI_TRANSFER_FEE_USD ?? 0.05);
  if (!Number.isFinite(feeUsd) || feeUsd <= 0) return 0;
  const { convertAmountBetween } = await import('../../payment/fxService');
  const { amount } = await convertAmountBetween(feeUsd, 'USD', LOCAL_SPEND_CURRENCY);
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
  const { convertAmountToUsd } = await import('../../payment/fxService');
  const total = amountNgn + feeNgn;
  const { usdAmount } = await convertAmountToUsd(total, LOCAL_SPEND_CURRENCY);
  return Number(usdBalance) >= Number(usdAmount);
}

export { paymentService };
