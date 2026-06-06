import crypto from 'node:crypto';
import { db } from '../../config/database';
import {
  createBillPayment,
  fetchBillBillers,
  fetchBillCategories,
  fetchBillItems,
  fetchBillPaymentStatus,
  validateBillCustomer,
} from './flutterwaveService';
import {
  convertAmountToUsd,
  creditUsdBalance,
  debitUsdBalance,
} from './balanceService';
import { PRIMARY_CURRENCY } from './walletModel';
import { formatBillPayLabel } from './walletActivityService';
import {
  notifyBillPayFailed,
  notifyBillPaySuccess,
  safeNotify,
} from '../notifications/notificationService';

const SKIP_VALIDATE_CATEGORIES = new Set(['AIRTIME', 'MOBILEDATA']);

export class BillsService {
  async getCategories() {
    return fetchBillCategories();
  }

  async getBillers(categoryCode: string) {
    return fetchBillBillers(categoryCode, 'NG');
  }

  async getItems(billerCode: string) {
    return fetchBillItems(billerCode);
  }

  async validateBill(params: {
    categoryCode: string;
    billerCode: string;
    itemCode: string;
    customerId: string;
  }) {
    const category = params.categoryCode.toUpperCase();
    if (SKIP_VALIDATE_CATEGORIES.has(category)) {
      return {
        skipped: true,
        customer: params.customerId,
        response_message: 'Validation not required for airtime and data',
      };
    }
    return validateBillCustomer({
      billerCode: params.billerCode,
      itemCode: params.itemCode,
      customerId: params.customerId,
    });
  }

  async payBill(params: {
    userId: string;
    categoryCode: string;
    billerCode: string;
    itemCode: string;
    customerId: string;
    amount: number;
    billerName?: string;
    itemName?: string;
    pin?: string;
  }): Promise<Record<string, unknown>> {
    const userId = params.userId;
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Invalid bill amount');
    }

    const usdWallet = await db.oneOrNone<{
      wallet_id: string;
      balance: string;
    }>(
      `SELECT wallet_id, balance FROM wallets
       WHERE user_id = $1 AND currency = $2 LIMIT 1`,
      [userId, PRIMARY_CURRENCY]
    );
    if (!usdWallet) {
      throw new Error('Wallet not found');
    }

    const { usdAmount } = await convertAmountToUsd(amount, 'NGN');
    if (Number(usdWallet.balance) < usdAmount) {
      throw new Error('Insufficient balance');
    }

    const reference = `dayfi-bill-${crypto.randomUUID()}`;
    const idempotencyKey = `bill-pay-${reference}`;

    const category = params.categoryCode.toUpperCase();
    if (!SKIP_VALIDATE_CATEGORIES.has(category)) {
      await validateBillCustomer({
        billerCode: params.billerCode,
        itemCode: params.itemCode,
        customerId: params.customerId,
      });
    }

    await debitUsdBalance({
      userId,
      walletId: usdWallet.wallet_id,
      amountUsd: usdAmount,
      source: 'bill_pay',
      idempotencyKey,
      externalReference: reference,
      metadata: {
        payWithCurrency: 'NGN',
        ngnAmount: amount,
        categoryCode: params.categoryCode,
        billerCode: params.billerCode,
        itemCode: params.itemCode,
        customerId: params.customerId,
        billerName: params.billerName,
        itemName: params.itemName,
      },
    });

    let fwResult: Record<string, unknown>;
    try {
      fwResult = await createBillPayment({
        billerCode: params.billerCode,
        itemCode: params.itemCode,
        customerId: params.customerId,
        amount,
        reference,
        country: 'NG',
      });
    } catch (err) {
      await creditUsdBalance({
        userId,
        walletId: usdWallet.wallet_id,
        amount: usdAmount,
        fromCurrency: PRIMARY_CURRENCY,
        source: 'manual',
        idempotencyKey: `${idempotencyKey}-reversal`,
        externalReference: `${reference}-reversal`,
        metadata: {
          reversal: true,
          reason: 'bill_payment_failed',
          ngnAmount: amount,
          categoryCode: params.categoryCode,
          billerCode: params.billerCode,
          itemCode: params.itemCode,
          customerId: params.customerId,
          billerName: params.billerName,
          itemName: params.itemName,
          originalReference: reference,
        },
      });
      await safeNotify(
        () =>
          notifyBillPayFailed({
            userId,
            amount,
            categoryCode: params.categoryCode,
            billerName:
              params.billerName?.trim() ||
              params.itemName?.trim() ||
              params.categoryCode,
            reference,
            reason: err instanceof Error ? err.message : String(err),
          }),
        'bill_pay_failed'
      );
      throw err;
    }

    const billMeta = {
      categoryCode: params.categoryCode,
      billerName: params.billerName,
      itemName: params.itemName,
      customerId: params.customerId,
    };
    const billLabel = formatBillPayLabel(billMeta);

    await safeNotify(
      () =>
        notifyBillPaySuccess({
          userId,
          amount,
          billerName: params.billerName?.trim() || billLabel,
          customerId: params.customerId,
          reference,
        }),
      'bill_pay'
    );

    const fwTxRef = String(fwResult.tx_ref ?? '').trim();
    let statusData: Record<string, unknown> | null = null;
    if (fwTxRef) {
      try {
        statusData = await fetchBillPaymentStatus(fwTxRef);
      } catch {
        statusData = null;
      }
    }

    const updated = await db.one<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1`,
      [usdWallet.wallet_id]
    );

    return {
      reference,
      amount,
      currency: 'NGN',
      debitedUsd: usdAmount,
      newBalance: Number(updated.balance),
      newBalanceCurrency: PRIMARY_CURRENCY,
      flutterwave: fwResult,
      status: statusData,
      rechargeToken:
        statusData?.extra ??
        fwResult.recharge_token ??
        null,
    };
  }
}

export const billsService = new BillsService();
