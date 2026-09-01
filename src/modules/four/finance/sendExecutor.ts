import { db } from '../../../config/database';
import HashText from '../../../shared/services/hashing';
import { paymentService } from './balanceService';
import { LOCAL_SPEND_CURRENCY } from '../../payment/walletModel';
import { estimateTransferFeeNgn } from './balanceService';
import type { ResolvedRecipient } from './recipientResolver';
import { resolveBankName } from './recipientResolver';

export async function verifyUserPin(
  userId: string,
  pin: string
): Promise<boolean> {
  const row = await db.oneOrNone<{ transaction_pin: string | null }>(
    `SELECT transaction_pin FROM users WHERE user_id = $1`,
    [userId]
  );
  if (!row?.transaction_pin) return false;
  return HashText.verifyHash(pin, String(row.transaction_pin));
}

export async function executeBankSend(input: {
  userId: string;
  amount: number;
  recipient: ResolvedRecipient;
}): Promise<{ reference: string; message: string }> {
  const fee = await estimateTransferFeeNgn();
  const bankName = await resolveBankName(input.recipient.bankCode);

  const wallet = await paymentService.getWalletByCurrency(input.userId, 'USD');
  if (!wallet) {
    throw new Error('Wallet not found. Please set up your wallet first.');
  }

  const result = await paymentService.bankTransfer(
    input.amount,
    input.recipient.name,
    input.recipient.accountNumber,
    input.recipient.bankCode,
    bankName,
    String(fee),
    input.userId,
    wallet.wallet_id,
    LOCAL_SPEND_CURRENCY
  );

  return {
    reference: String(result.transferCode ?? result.reference ?? ''),
    message: `✅ Sent successfully.\n\n₦${input.amount.toLocaleString('en-NG')}\n${input.recipient.name} (${bankName})`,
  };
}
