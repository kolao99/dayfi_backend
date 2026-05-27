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
  creditWalletBalance,
  debitWalletBalance,
} from './balanceService';
import { recordWalletActivity } from './walletActivityService';

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

    const wallet = await db.oneOrNone<{
      wallet_id: string;
      balance: string;
      currency: string;
    }>(
      `SELECT wallet_id, balance, currency FROM wallets
       WHERE user_id = $1 AND currency = 'NGN' LIMIT 1`,
      [userId]
    );
    if (!wallet) {
      throw new Error('NGN wallet required for bill payments');
    }
    if (Number(wallet.balance) < amount) {
      throw new Error('Insufficient NGN balance');
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

    await debitWalletBalance({
      userId,
      walletId: wallet.wallet_id,
      amount,
      currency: 'NGN',
      source: 'bill_pay',
      idempotencyKey,
      externalReference: reference,
      metadata: {
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
      const { usdAmount } = await convertAmountToUsd(amount, 'NGN');
      await creditWalletBalance({
        userId,
        walletId: wallet.wallet_id,
        amount,
        currency: 'NGN',
        usdEquivalent: usdAmount,
        source: 'manual',
        idempotencyKey: `${idempotencyKey}-reversal`,
        externalReference: `${reference}-reversal`,
        metadata: { reversal: true, reason: 'bill_payment_failed' },
      });
      throw err;
    }

    const label =
      params.itemName?.trim() ||
      params.billerName?.trim() ||
      `${params.categoryCode} bill`;

    await recordWalletActivity({
      userId,
      id: reference,
      direction: 'debit',
      amount,
      currency: 'NGN',
      source: 'bank_out',
      title: label,
      reason: `${label} · ${params.customerId}`,
      channel: 'bank',
      status: 'success-payment',
      beneficiaryName: params.billerName ?? 'Bill Payment',
      externalReference: String(fwResult.tx_ref ?? fwResult.reference ?? reference),
    });

    let statusData: Record<string, unknown> | null = null;
    try {
      statusData = await fetchBillPaymentStatus(reference);
    } catch {
      statusData = null;
    }

    const updated = await db.one<{ balance: string }>(
      `SELECT balance FROM wallets WHERE wallet_id = $1`,
      [wallet.wallet_id]
    );

    return {
      reference,
      amount,
      currency: 'NGN',
      newBalance: Number(updated.balance),
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
