import crypto from 'node:crypto';
import {
  fetchBanks,
  resolveBankDetails,
  chargeCard,
  initiateTransfer,
  chargeCardWithToken,
  verifyCharge,
  verifyPayment,
  flutterwaveErrorMessage,
} from './flutterwaveService';
import { db } from '../../config/database';
import DBService from '../../shared/services/db.service';
import enums from '../../shared/lib/enums';
import config from '../../config/env';
import {
  LOCAL_SPEND_CURRENCY,
  PRIMARY_CURRENCY,
  WALLET_PROVIDER,
  formatLedgerBalances,
  formatPrdWalletDetails,
} from './walletModel';
import { creditUsdInflow } from './inflowService';
import { normalizeDayfiId } from '../authentication/socialAuth';
import {
  ensurePlatformExchangeRates,
  resolveExchangeRate,
  convertAmountBetween,
  convertAmountToUsd,
} from './fxService';
import {
  debitWalletBalance,
  creditWalletBalance,
  debitUsdBalance,
  creditUsdBalance,
  buildIdempotencyKey,
  newReference,
  reverseYellowCardWalletDebit,
} from './balanceService';
import { transferByDayfiTag } from './p2pService';
import { normalizeRecipientPhone } from './recipientPhone';
import {
  matchYellowCardNetwork,
  parseYellowCardNetworks,
  resolveFlutterwaveBankName,
  resolveYellowCardNetworkId,
} from './yellowCardNetworkResolver';
import YellowCardService from './yellowCardService';
import {
  buildYellowCardSendPartyFields,
} from './yellowCardSender';
import { assertYellowCardSendWithinLimits } from './yellowCardSendLimits';
import { resolveYellowCardPaymentStatus } from './yellowCardStatus';
import { createVirtualAccount } from './flutterwaveService';
import {
  recordWalletActivity,
  backfillWalletActivitiesFromLedger,
  buildWalletActivityTxId,
  repairBillWalletTransactions,
  repairP2pWalletTransactions,
  repairYellowCardWalletTransactions,
  repairFailedWalletTransactionStatuses,
  repairUnreversedFailedYellowCardDebits,
} from './walletActivityService';
import {
  notifyBankSend,
  notifyBankSendFailed,
  safeNotify,
} from '../notifications/notificationService';

type TransactionCountResult = { total: string | number };

type WalletTransactionRow = {
  id?: string;
  external_reference?: string | null;
  ledger_currency?: string | null;
  beneficiary?: { name?: string | null } | null;
  timestamp?: string | Date;
};

function walletTransactionQuality(row: WalletTransactionRow): number {
  let score = 0;
  if (row.ledger_currency) score += 4;
  if (String(row.id ?? '').startsWith('wt-')) score += 2;
  const name = String(row.beneficiary?.name ?? '').trim();
  if (name && name.toLowerCase() !== 'recipient') score += 1;
  const reason = String((row as { reason?: string | null }).reason ?? '')
    .trim()
    .toLowerCase();
  if (reason.startsWith('send to ')) score += 8;
  const status = String((row as { status?: string | null }).status ?? '')
    .toLowerCase();
  if (status === 'failed-payment') score -= 20;
  if (status === 'success-payment') score += 3;
  return score;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function walletTransactionDedupeKey(row: WalletTransactionRow): string {
  const id = String(row.id ?? '').trim();
  const bareId = id.replace(/^wt-/, '');
  if (UUID_RE.test(bareId)) return bareId.toLowerCase();

  const ext = String(row.external_reference ?? '').trim();
  if (UUID_RE.test(ext)) return ext.toLowerCase();
  if (ext) return ext;

  if (id.startsWith('wt-p2p-debit-')) return id.replace(/^wt-p2p-debit-/, '');
  if (id.startsWith('wt-p2p-credit-')) return `credit:${id.replace(/^wt-p2p-credit-/, '')}`;
  if (id.startsWith('wt-')) return id.slice(3);
  return id;
}

function dedupeWalletTransactions<T extends WalletTransactionRow>(
  rows: T[]
): T[] {
  const bestByKey = new Map<string, T>();
  for (const row of rows) {
    const key = walletTransactionDedupeKey(row);
    const existing = bestByKey.get(key);
    if (!existing || walletTransactionQuality(row) > walletTransactionQuality(existing)) {
      bestByKey.set(key, row);
    }
  }
  return Array.from(bestByKey.values()).sort((a, b) => {
    const aTime = new Date(String(a.timestamp ?? 0)).getTime();
    const bTime = new Date(String(b.timestamp ?? 0)).getTime();
    return bTime - aTime;
  });
}

export type Wallet = {
  id: string;
  wallet_id: string;
  user_id: string;
  balance: number;
  currency: string;
  created_at: Date;
  updated_at: Date;
};

class PaymentService {
  private dbService: DBService;

  constructor() {
    this.dbService = new DBService();
  }

  async resolveBankAccount(
    accountNumber: string,
    bankCode: string
  ): Promise<any> {
    try {
      const response = await resolveBankDetails(accountNumber, bankCode);
      const data = response?.data?.data ?? response?.data;

      return {
        success: true,
        accountName: String(data?.account_name ?? ''),
        accountNumber: String(data?.account_number ?? accountNumber),
        bankCode: String(bankCode),
        bankName: String(data?.bank_name ?? ''),
      };
    } catch (error: any) {
      const fwMsg =
        error?.response?.data?.message ||
        error?.response?.data?.data?.complete_message ||
        error.message;
      console.error('Error resolving bank account:', fwMsg);
      throw new Error(
        'Unable to verify account details at this time. Please try again.'
      );
    }
  }

  async fetchBanks(): Promise<any> {
    return fetchBanks();
  }

  /** Map Flutterwave bank list → network rows for mobile send UI (YC id when available). */
  async fetchNigerianBankNetworks(): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      country: string;
      status: string;
      accountNumberType: string;
      channelIds: string[];
    }>
  > {
    const { banks } = await fetchBanks();
    const yc = new YellowCardService();
    let ycNetworks = parseYellowCardNetworks([]);
    if (yc.isConfigured()) {
      try {
        const raw = await yc.fetchNetworks();
        ycNetworks = parseYellowCardNetworks(raw).filter(
          (n) => n.status !== 'inactive'
        );
      } catch (err: unknown) {
        console.warn(
          `[fetchNigerianBankNetworks] Yellow Card networks unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    return banks.map((b) => {
      const match =
        ycNetworks.length > 0
          ? matchYellowCardNetwork({
              bankName: b.name,
              flutterwaveCode: b.code,
              country: 'NG',
              networks: ycNetworks,
            })
          : null;
      const channelIds =
        match?.channelIds && match.channelIds.length > 0
          ? match.channelIds
          : ['ngn_bank_flutterwave'];

      return {
        id: match?.id ?? b.code,
        code: b.code,
        name: b.name,
        country: 'NG',
        status: 'active',
        accountNumberType: 'NUBAN',
        channelIds,
      };
    });
  }

  private async createWalletRow(
    userId: string,
    currency: string,
    provider: string
  ): Promise<Wallet> {
    const reference = `dayfi-${currency.toLowerCase()}-${userId}-${Date.now()}`;
    const row = await this.dbService.singleTransaction<Wallet>(
      'createOtherWallet',
      [userId, reference, currency, provider],
      enums.PAYMENT_QUERY
    );
    if (!row) {
      throw new Error(`Failed to create ${currency} wallet`);
    }
    return row;
  }

  /** Unified USD balance — all inflows credit this wallet. */
  async ensureUsdWallet(userId: string): Promise<Wallet> {
    const existing = await this.dbService.singleTransaction<Wallet>(
      'getUserWalletByCurrency',
      [userId, PRIMARY_CURRENCY],
      enums.PAYMENT_QUERY
    );
    if (existing) return existing;
    return this.createWalletRow(
      userId,
      PRIMARY_CURRENCY,
      WALLET_PROVIDER.PLATFORM
    );
  }

  /** Optional NGN balance for local spend (tap-to-pay, etc.). */
  async ensureNgnWallet(userId: string): Promise<Wallet> {
    const existing = await this.dbService.singleTransaction<Wallet>(
      'getUserWalletByCurrency',
      [userId, LOCAL_SPEND_CURRENCY],
      enums.PAYMENT_QUERY
    );
    if (existing) return existing;
    return this.createWalletRow(
      userId,
      LOCAL_SPEND_CURRENCY,
      WALLET_PROVIDER.PLATFORM
    );
  }

  async ensureWalletForCurrency(
    userId: string,
    currency: string
  ): Promise<Wallet> {
    const c = String(currency).toUpperCase();
    if (c === PRIMARY_CURRENCY) return this.ensureUsdWallet(userId);
    if (c === LOCAL_SPEND_CURRENCY) return this.ensureNgnWallet(userId);
    const existing = await this.dbService.singleTransaction<Wallet>(
      'getUserWalletByCurrency',
      [userId, c],
      enums.PAYMENT_QUERY
    );
    if (existing) return existing;
    return this.createWalletRow(userId, c, WALLET_PROVIDER.PLATFORM);
  }

  /**
   * Global wallet: USD ledger + NGN row for Flutterwave VA metadata only.
   */
  async ensureUserLedgerWallets(userId: string): Promise<Record<string, Wallet>> {
    await ensurePlatformExchangeRates();
    const usd = await this.ensureUsdWallet(userId);
    const ngn = await this.ensureNgnWallet(userId);
    return { USD: usd, NGN: ngn };
  }

  async getWalletByCurrency(
    userId: string,
    currency: string
  ): Promise<Wallet | null> {
    return this.dbService.singleTransaction<Wallet>(
      'getUserWalletByCurrency',
      [userId, String(currency).toUpperCase()],
      enums.PAYMENT_QUERY
    );
  }

  async sumWalletBalancesUsd(userId: string): Promise<number> {
    const usd = await this.getUsdWallet(userId);
    return Number(usd?.balance ?? 0);
  }

  async formatPrdWalletResponse(wallets: Wallet[]) {
    return formatPrdWalletDetails(wallets as any);
  }

  /**
   * Credit inbound funds to the unified USD ledger (FX at credit time).
   */
  async creditWalletInflow(
    userId: string,
    amount: number,
    fromCurrency: string,
    _targetCurrency: string,
    source: 'grey' | 'stellar' | 'yellowcard' | 'flutterwave' | 'manual',
    externalReference: string
  ) {
    return this.creditUnifiedUsdInflow(
      userId,
      amount,
      fromCurrency,
      source,
      externalReference
    );
  }

  /** @deprecated Use [ensureUserLedgerWallets] or [ensureUsdWallet]. */
  async ensurePrimaryWallet(userId: string): Promise<Wallet> {
    const { usd } = await this.ensureUserLedgerWallets(userId);
    return usd;
  }

  async getUsdWallet(userId: string): Promise<Wallet | null> {
    return this.dbService.singleTransaction<Wallet>(
      'getUsdWalletByUserId',
      [userId],
      enums.PAYMENT_QUERY
    );
  }

  async getNgnWallet(userId: string): Promise<Wallet | null> {
    return this.dbService.singleTransaction<Wallet>(
      'getUserWalletByCurrency',
      [userId, LOCAL_SPEND_CURRENCY],
      enums.PAYMENT_QUERY
    );
  }

  getLedgerBalances(wallets: Wallet[]) {
    return formatLedgerBalances(wallets);
  }

  /**
   * Credits USD after an inflow (Grey, Stellar, Yellow Card collection, etc.).
   */
  async creditUnifiedUsdInflow(
    userId: string,
    amount: number,
    fromCurrency: string,
    source: 'grey' | 'stellar' | 'yellowcard' | 'flutterwave' | 'manual',
    externalReference?: string
  ): Promise<{
    usdAmount: number;
    rate: number | null;
    walletId: string;
    duplicate?: boolean;
  }> {
    if (!externalReference) {
      throw new Error('externalReference is required for idempotent inflows');
    }
    const usdWallet = await this.ensureUsdWallet(userId);
    const { usdAmount, rate, duplicate } = await creditUsdInflow({
      userId,
      usdWalletId: usdWallet.wallet_id,
      amount,
      fromCurrency,
      source,
      externalReference,
    });
    return { usdAmount, rate, walletId: usdWallet.wallet_id, duplicate };
  }

  /**
   * Yellow Card / external collection completed — convert if needed and credit USD.
   */
  async completeCollectionInflow(
    sequenceId: string,
    payload: {
      amount?: number;
      currency?: string;
      usdAmount?: number;
    } = {}
  ): Promise<void> {
    const tx = await this.dbService.singleTransaction<{
      id: string;
      user_id: string;
      send_amount: string | number;
      status: string;
    }>('getWalletTransactionById', [sequenceId], enums.PAYMENT_QUERY);

    if (!tx?.user_id) {
      throw new Error(`Collection transaction not found: ${sequenceId}`);
    }
    if (String(tx.status).startsWith('success-collection')) {
      return;
    }

    const fromCurrency = (
      payload.currency ?? PRIMARY_CURRENCY
    ).toUpperCase();
    const rawAmount =
      payload.usdAmount ??
      payload.amount ??
      Number(tx.send_amount ?? 0);

    await this.creditWalletInflow(
      tx.user_id,
      rawAmount,
      fromCurrency,
      fromCurrency,
      'yellowcard',
      sequenceId
    );

    await this.updateTransactionStatus(sequenceId, 'success-collection');
  }

  /** @deprecated Name kept for callers; ensures ledger wallets (Grey accounts provisioned separately). */
  async createCustomerAndVirtualAccount(
    userId: string,
    email: string,
    bvn: string,
    _userName: string
  ): Promise<any> {
    const wallets = await this.ensureUserLedgerWallets(userId);
    try {
      await this.ensureNgnVirtualAccount(userId, email, bvn);
    } catch (e) {
      console.warn('NGN VA provisioning skipped:', (e as Error).message);
    }
    return {
      success: true,
      wallet: wallets.USD,
      wallets,
    };
  }

  /** Flutterwave permanent NGN virtual account (PRD fiat inflow). */
  async ensureNgnVirtualAccount(
    userId: string,
    email: string,
    bvn: string
  ): Promise<Wallet & { account_number?: string; bank_name?: string; account_name?: string }> {
    const userRow = await db.oneOrNone<{
      first_name: string | null;
      last_name: string | null;
      phone_number: string | null;
    }>(
      `SELECT first_name, last_name, phone_number FROM users WHERE user_id = $1`,
      [userId]
    );
    const accountName =
      `${userRow?.first_name ?? ''} ${userRow?.last_name ?? ''}`.trim();

    const existing = await db.oneOrNone<{
      wallet_id: string;
      account_number: string | null;
      bank_name: string | null;
      account_name: string | null;
    }>(
      `SELECT wallet_id, account_number, bank_name, account_name FROM wallets
       WHERE user_id = $1 AND currency = 'NGN' LIMIT 1`,
      [userId]
    );
    if (existing?.account_number) {
      if (accountName && !String(existing.account_name ?? '').trim()) {
        await db.none(
          `UPDATE wallets SET account_name = $1, updated_at = CURRENT_TIMESTAMP
           WHERE wallet_id = $2`,
          [accountName, existing.wallet_id]
        );
      }
      const w = await this.getWalletByCurrency(userId, LOCAL_SPEND_CURRENCY);
      return {
        ...w!,
        account_number: existing.account_number,
        bank_name: existing.bank_name ?? undefined,
        account_name: String(existing.account_name ?? '').trim() || accountName || undefined,
      };
    }
    const ngn = await this.ensureNgnWallet(userId);

    const response = await createVirtualAccount(email, bvn, {
      firstname: userRow?.first_name ?? undefined,
      lastname: userRow?.last_name ?? undefined,
      phonenumber: userRow?.phone_number ?? undefined,
      narration: accountName || undefined,
    });
    const root = response?.data as Record<string, unknown> | undefined;
    const data = (root?.data ?? root) as Record<string, unknown> | undefined;
    const accountNumber = String(
      data?.account_number ?? data?.accountNumber ?? ''
    );
    const bankName = String(
      data?.bank_name ?? data?.bankName ?? 'Wema Bank'
    );
    if (!accountNumber) {
      const msg = String(root?.message ?? 'Flutterwave did not return a virtual account number');
      throw new Error(msg);
    }

    await db.none(
      `UPDATE wallets SET account_number = $1, bank_name = $2, account_name = $3,
       provider = $4, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $5`,
      [
        accountNumber,
        bankName,
        accountName || null,
        WALLET_PROVIDER.FLUTTERWAVE,
        ngn.wallet_id,
      ]
    );

    const updated = await this.getWalletByCurrency(userId, LOCAL_SPEND_CURRENCY);
    return updated!;
  }

  /** Instant transfer to another user's Dayfi tag in any of the 4 currencies. */
  async transferP2p(
    senderUserId: string,
    senderWalletId: string,
    recipientDayfiId: string,
    amount: number,
    currency: string
  ): Promise<{
    success: boolean;
    reference: string;
    newBalance: number;
    message: string;
  }> {
    const result = await transferByDayfiTag({
      senderUserId,
      senderWalletId,
      recipientDayfiId,
      amount,
      currency: String(currency).toUpperCase(),
    });
    return {
      success: true,
      reference: result.reference,
      newBalance: result.newBalance,
      message: 'Transfer completed successfully',
    };
  }

  /** @deprecated Use [transferP2p] */
  async transferP2pUsd(
    senderUserId: string,
    senderWalletId: string,
    recipientDayfiId: string,
    amountUsd: number
  ) {
    return this.transferP2p(
      senderUserId,
      senderWalletId,
      recipientDayfiId,
      amountUsd,
      PRIMARY_CURRENCY
    );
  }

  /** @deprecated Use [transferP2pUsd]. Kept for route name compatibility. */
  async transferToVirtualAccount(
    amount: number,
    _name: string,
    _accountNumber: string,
    _bankCode: string,
    _bankName: string,
    userId: string,
    walletId: string,
    _balance: number,
    _recipientWalletId: string,
    recipientDayfiId: string
  ): Promise<any> {
    const wallet = await this.dbService.singleTransaction<Wallet>(
      'getUserWalletByCurrency',
      [userId, PRIMARY_CURRENCY],
      enums.PAYMENT_QUERY
    );
    return this.transferP2p(
      userId,
      walletId,
      recipientDayfiId,
      amount,
      wallet?.currency ?? PRIMARY_CURRENCY
    );
  }

  async bankTransfer(
    amount: number,
    accountName: string,
    accountNumber: string,
    bankCode: string,
    bankName: string,
    fee: string,
    userId: string,
    _walletId: string,
    spendCurrency: string
  ): Promise<any> {
    const reference = `bank-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const currency = String(spendCurrency || 'NGN').toUpperCase();

    if (currency === PRIMARY_CURRENCY) {
      throw new Error(
        'USD bank payouts use Grey (configure DAYFI_GREY_*). Use Yellow Card for African corridors or spendCurrency NGN for Nigeria.'
      );
    }

    const feeNum = Number(fee) || 0;
    const totalDebit = amount + feeNum;

    const usdWallet = await this.ensureUsdWallet(userId);
    const { usdAmount } = await convertAmountToUsd(totalDebit, LOCAL_SPEND_CURRENCY);
    const debitKey = buildIdempotencyKey('bank_out', reference);

    await debitUsdBalance({
      userId,
      walletId: usdWallet.wallet_id,
      amountUsd: usdAmount,
      source: 'bank_out',
      idempotencyKey: debitKey,
      externalReference: reference,
      metadata: {
        payWithCurrency: LOCAL_SPEND_CURRENCY,
        ngnAmount: totalDebit,
        payoutAmount: amount,
        fee: feeNum,
      },
    });

    const narration = 'Bank Transfer';
    const meta = {
      FirstName: accountName.split(' ')[0],
      LastName: accountName.split(' ')[1] || '',
    };

    try {
      const response = await initiateTransfer(
        bankCode,
        accountNumber,
        amount,
        narration,
        LOCAL_SPEND_CURRENCY,
        reference,
        accountName,
        meta
      );

      await recordWalletActivity({
        userId,
        id: reference,
        direction: 'debit',
        amount,
        currency: LOCAL_SPEND_CURRENCY,
        source: 'bank_out',
        title: `Transfer to ${accountName}`,
        reason: `Bank transfer to ${accountName} (${bankName})`,
        channel: 'bank',
        status: 'success-payment',
        beneficiaryName: accountName,
        accountNumber,
        bankName,
        externalReference: reference,
      });

      await safeNotify(
        () =>
          notifyBankSend({
            userId,
            amount,
            currency: LOCAL_SPEND_CURRENCY,
            recipientName: accountName,
            bankName,
            reference,
          }),
        'bank_send'
      );

      return {
        success: true,
        transferCode: reference,
        response,
        message: 'Transfer initiated successfully',
      };
    } catch (err: unknown) {
      await creditUsdBalance({
        userId,
        walletId: usdWallet.wallet_id,
        amount: usdAmount,
        fromCurrency: PRIMARY_CURRENCY,
        source: 'manual',
        idempotencyKey: `${debitKey}-reversal`,
        externalReference: `${reference}-reversal`,
        metadata: { reversal: true, reason: 'bank_transfer_failed' },
      });
      const msg = flutterwaveErrorMessage(err, 'Flutterwave bank transfer failed');
      console.error(
        `[bankTransfer] Flutterwave payout failed user=${userId} ref=${reference} bank=${bankCode} acct=${accountNumber} amount=${amount}: ${msg}`
      );
      throw new Error(msg);
    }
  }

  async verifyTransfer({
    transactionReference,
    status,
    amount,
    fee,
  }: {
    transactionReference: string;
    status: string;
    amount: number;
    fee: string;
  }): Promise<any> {
    try {
      const transaction: any = await this.dbService.singleTransaction(
        'getWalletTransactionByReference',
        [transactionReference],
        enums.PAYMENT_QUERY
      );

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      const senderWalletId = transaction?.sender_wallet_id;
      const receiverWalletId = transaction?.receiver_wallet_id;

      if (status === 'SUCCESSFUL') {
        if (receiverWalletId) {
          await this.dbService.singleTransaction(
            'creditWalletBalance',
            [amount, receiverWalletId],
            enums.PAYMENT_QUERY
          );
        }

        const wallet: any = await this.dbService.singleTransaction(
          'debitWalletBalance',
          [amount, senderWalletId],
          enums.PAYMENT_QUERY
        );

        const newBalance = wallet.balance;

        await this.dbService.singleTransaction(
          'markTransferSuccessful',
          [newBalance, transactionReference, 'success', fee],
          enums.PAYMENT_QUERY
        );
      } else {
        await this.dbService.singleTransaction(
          'markTransferFailed',
          [transactionReference, 'failed'],
          enums.PAYMENT_QUERY
        );
      }
    } catch (error: any) {
      console.error('Error verifying transfer:', error.message);
      throw new Error('Unable to verify transfer');
    }
  }

  async chargeUserCard({
    cardNumber,
    cvv,
    expiryMonth,
    expiryYear,
    amount,
    email,
    phoneNumber,
    firstName,
    lastName,
    IP,
    redirectUrl,
    suggestedAuth,
    pin,
    userId,
    walletId,
  }: {
    cardNumber: string;
    cvv: string;
    expiryMonth: string;
    expiryYear: string;
    amount: number;
    email: string;
    phoneNumber: string;
    firstName: string;
    lastName: string;
    IP: string;
    redirectUrl: string;
    suggestedAuth: string;
    pin: string;
    userId: string;
    walletId: string;
  }): Promise<any> {
    try {
      const txRef = `trans-${Date.now()}`;

      const chargeData = {
        PBFPubKey: config?.FLUTTERWAVE_PUBLIC_KEY,
        cardno: cardNumber,
        cvv,
        expirymonth: expiryMonth,
        expiryyear: expiryYear,
        currency: 'NGN',
        country: 'NG',
        amount,
        email,
        phonenumber: phoneNumber,
        firstname: firstName,
        lastname: lastName,
        IP,
        txRef,
        redirect_url: redirectUrl,
        suggested_auth: suggestedAuth,
        pin,
      };

      const response = await chargeCard(chargeData);

      const cardData = response?.data || {};
      const cardToken =
        response?.data?.data?.card?.card_tokens?.[0]?.embedtoken || null;

      const walletTransaction = await this.dbService.singleTransaction(
        'createCardWalletTransaction',
        [
          userId,
          walletId,
          amount,
          'card_to_wallet',
          'pending',
          txRef,
          `Funding wallet via card: ${cardData?.type || 'Card'}`,
          {},
          userId,
          cardData?.last4 || null,
          cardData?.type || null,
          cardData?.brand || null,
          cardData?.country || null,
          cardToken,
          cardData.flwRef,
        ],
        enums.PAYMENT_QUERY
      );

      return {
        success: true,
        data: {
          chargeResponse: response,
          walletTransaction,
        },
      };
    } catch (error: any) {
      console.error('Error charging user card:', error.message);
      throw new Error('Unable to charge user card at this time');
    }
  }

  async verifyCharge({
    transactionReference,
    otp,
  }: {
    transactionReference: string;
    otp: string;
  }): Promise<any> {
    try {
      const response = await verifyCharge(transactionReference, otp);

      if (
        response?.data?.data?.responsecode === '00' ||
        response?.data?.tx?.status === 'successful'
      ) {
        await this.dbService.singleTransaction(
          'updateTransactionStatusToProcessing',
          [transactionReference],
          enums.PAYMENT_QUERY
        );
      }

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      console.error('Error verifying charge:', error.message);
      throw new Error('Unable to verify charge with OTP');
    }
  }

  async verifyPayment({
    transactionReference,
  }: {
    transactionReference: string;
  }): Promise<any> {
    try {
      const response = await verifyPayment(transactionReference);
      const data = response?.data;

      if (!data || data.status !== 'successful') {
        throw new Error('Payment not successful');
      }

      const { amount, txref } = data;

      const transaction: any = await this.dbService.singleTransaction(
        'getWalletTransactionByReference',
        [txref],
        enums.PAYMENT_QUERY
      );

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      const senderWalletId = transaction?.recipient_wallet_id;

      const wallet: any = await this.dbService.singleTransaction(
        'creditWalletBalance',
        [amount, senderWalletId],
        enums.PAYMENT_QUERY
      );

      const newBalance = wallet.balance;

      await this.dbService.singleTransaction(
        'markTransactionSuccessful',
        [
          newBalance,
          txref,
          data.card.type,
          data.card.brand,
          data.card.issuing_country,
          data.card.card_tokens[0].embedtoken,
          data.card.last4digits,
        ],
        enums.PAYMENT_QUERY
      );

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      console.error('Error verifying payment:', error.message);
      throw new Error('Unable to verify payment');
    }
  }

  async chargeUserWithToken({
    token,
    amount,
    email,
    firstname,
    lastname,
    IP,
    narration,
  }: {
    token: string;
    amount: number;
    email: string;
    firstname: string;
    lastname: string;
    IP: string;
    narration: string;
  }): Promise<any> {
    try {
      const response = await chargeCardWithToken(
        token,
        amount,
        'NGN',
        'NG',
        email,
        firstname,
        lastname,
        IP,
        narration
      );

      return {
        success: true,
        data: response,
      };
    } catch (error: any) {
      console.error('Error charging user with token:', error.message);
      throw new Error('Unable to charge user with token at this time');
    }
  }

  async getWalletByDayfiId(dayfiId: string): Promise<any> {
    const normalized = normalizeDayfiId(dayfiId);
    if (!normalized) return null;
    return await this.dbService.singleTransaction(
      'getWalletByDayfiId',
      [normalized],
      enums.PAYMENT_QUERY
    );
  }

  /** Primary spending wallet (unified USD). */
  async getWalletByUserId(userId: string): Promise<Wallet | null> {
    const usd = await this.getUsdWallet(userId);
    if (usd) return usd;
    return this.dbService.singleTransaction<Wallet>(
      'getWalletByUserId',
      [userId],
      enums.PAYMENT_QUERY
    );
  }

  async fetchUserWalletByCurrency(
    userId: string,
    currency: string
  ): Promise<Wallet | null> {
    return this.dbService.singleTransaction<Wallet>(
      'fetchUserWalletByCurrency',
      [userId, currency],
      enums.PAYMENT_QUERY
    );
  }

  async getWalletsByUserId(userId: string): Promise<any> {
    return await this.dbService.transact(
      'getWalletsByUserId',
      [userId],
      enums.PAYMENT_QUERY
    );
  }

  async addDayfiId(dayfiId: string, userId: string): Promise<any> {
    const normalized = normalizeDayfiId(dayfiId);
    if (!normalized) {
      throw new Error('Please enter a valid Dayfi Tag.');
    }

    const existing = await this.getWalletByDayfiId(normalized);
    if (existing?.user_id && String(existing.user_id) !== String(userId)) {
      throw new Error('This Dayfi Tag is already taken. Try another.');
    }

    return await this.dbService.singleTransaction(
      'updateWalletWithDayfiId',
      [normalized, userId],
      enums.PAYMENT_QUERY
    );
  }

  async fetchWalletTransactions(
    userId: string,
    status: string | null,
    startDate: string | null,
    endDate: string | null,
    searchTerm: string | null,
    limit: number,
    offset: number,
    sortOrder: string | null
  ): Promise<any> {
    if (offset === 0) {
      try {
        await backfillWalletActivitiesFromLedger(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] ledger backfill skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        await repairP2pWalletTransactions(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] p2p repair skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        await repairBillWalletTransactions(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] bill repair skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        await repairYellowCardWalletTransactions(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] yellowcard repair skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        const { syncYellowCardPaymentStatusesForUser } = await import(
          './walletActivityService'
        );
        await syncYellowCardPaymentStatusesForUser(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] yellowcard status sync skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        await repairFailedWalletTransactionStatuses(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] failed-status repair skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        const repair = await repairUnreversedFailedYellowCardDebits(userId);
        if (repair.reversed > 0) {
          console.info(
            `[fetchWalletTransactions] reversed ${repair.reversed} failed YC debits ($${repair.totalUsd.toFixed(2)}) user=${userId}`
          );
        }
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] YC reversal repair skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      try {
        const { repairFlutterwaveDepositActivities } = await import(
          './flutterwaveInflowService'
        );
        await repairFlutterwaveDepositActivities(userId);
      } catch (err: unknown) {
        console.warn(
          `[fetchWalletTransactions] flutterwave deposit repair skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    const getSortSuffix = () =>
      sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const transactionsQueryPromise = this.dbService.transact(
      'fetchWalletTransactions',
      [
        userId,
        status,
        startDate,
        endDate,
        searchTerm,
        limit,
        offset,
        getSortSuffix(),
      ],
      enums.PAYMENT_QUERY
    );

    const transactionCountPromise = this.dbService.transact(
      'fetchWalletTransactionsCount',
      [userId, status, startDate, endDate, searchTerm],
      enums.PAYMENT_QUERY
    );

    const [transactionsResult, transactionCountResult] = await Promise.all([
      transactionsQueryPromise,
      transactionCountPromise,
    ]);

    const dedupedTransactions = dedupeWalletTransactions(
      (transactionsResult as WalletTransactionRow[]) ?? []
    );

    const countRow = transactionCountResult[0] as TransactionCountResult;
    const totalCount = Number(countRow?.total || 0);
    const totalPages = Math.ceil(totalCount / limit);
    const currentPage = Math.max(1, Math.floor(offset / limit) + 1);

    return {
      transactions: dedupedTransactions,
      totalCount,
      totalPages,
      page: currentPage,
      limit,
    };
  }

  async createWallet(userId: string, currency: string): Promise<Wallet | null> {
    const normalized = currency.toUpperCase();
    if (normalized === PRIMARY_CURRENCY) {
      return this.ensureUsdWallet(userId);
    }
    if (normalized === LOCAL_SPEND_CURRENCY) {
      return this.ensureNgnWallet(userId);
    }
    const reference = `wallet-ref-${Date.now()}`;
    return this.dbService.singleTransaction<Wallet>(
      'createOtherWallet',
      [userId, reference, normalized, WALLET_PROVIDER.PLATFORM],
      enums.PAYMENT_QUERY
    );
  }

  async createExchangeRate(
    base: string,
    target: string,
    rate: number,
    source = 'manual'
  ): Promise<any> {
    return this.dbService.singleTransaction(
      'createExchangeRate',
      [base, target, rate, source],
      enums.PAYMENT_QUERY
    );
  }

  async getExchangeRate(base: string, target: string): Promise<number> {
    return resolveExchangeRate(base, target);
  }

  async swapCurrency(
    userId: string,
    fromCurrency: string,
    toCurrency: string,
    amount: number
  ): Promise<any> {
    const from = String(fromCurrency).trim().toUpperCase();
    const to = String(toCurrency).trim().toUpperCase();

    if (from === to) {
      throw new Error('Cannot swap the same currency');
    }

    await this.ensureWalletForCurrency(userId, from);
    await this.ensureWalletForCurrency(userId, to);

    const fromWallet = await this.dbService.singleTransaction<any>(
      'getUserWalletByCurrency',
      [userId, from],
      enums.PAYMENT_QUERY
    );

    const toWallet = await this.dbService.singleTransaction<any>(
      'getUserWalletByCurrency',
      [userId, to],
      enums.PAYMENT_QUERY
    );

    if (!fromWallet || !toWallet) {
      throw new Error('Wallet not found for one or both currencies');
    }

    if (Number(fromWallet.balance) < amount) {
      throw new Error('Insufficient balance in source wallet');
    }

    const rate = await resolveExchangeRate(from, to);
    const { amount: convertedAmount } = await convertAmountBetween(
      amount,
      from,
      to
    );

    const reference = newReference('swap');
    const convertLabel = `Convert ${from} → ${to}`;
    const swapMeta = {
      activityTitle: convertLabel,
      fromCurrency: from,
      toCurrency: to,
      rate,
      convertedAmount,
    };

    await debitWalletBalance({
      userId,
      walletId: fromWallet.wallet_id,
      amount,
      currency: from,
      source: 'swap',
      idempotencyKey: buildIdempotencyKey('swap-debit', reference),
      externalReference: reference,
      metadata: swapMeta,
    });

    const { usdAmount } = await convertAmountToUsd(convertedAmount, to);

    await creditWalletBalance({
      userId,
      walletId: toWallet.wallet_id,
      amount: convertedAmount,
      currency: to,
      usdEquivalent: usdAmount,
      source: 'swap',
      idempotencyKey: buildIdempotencyKey('swap-credit', reference),
      externalReference: reference,
      metadata: swapMeta,
    });

    await this.dbService.singleTransaction(
      'logSwap',
      [
        userId,
        fromWallet.wallet_id,
        toWallet.wallet_id,
        from,
        to,
        amount,
        rate,
        convertedAmount,
      ],
      enums.PAYMENT_QUERY
    );

    return {
      success: true,
      message: 'Currency swapped successfully',
      rate,
      convertedAmount,
      reference,
    };
  }

  async createBeneficiary(
    name: string,
    country: string,
    phone: string,
    address: string,
    dob: string,
    email: string,
    idNumber: string,
    idType: string,
    userId: string
  ): Promise<any> {
    return this.dbService.singleTransaction<any>(
      'createBeneficiary',
      [name, country, phone, address, dob, email, idNumber, idType, userId],
      enums.PAYMENT_QUERY
    );
  }

  async createSource(
    accountType: string,
    accountNumber: string,
    networkId: string,
    beneficiaryId: string
  ): Promise<any> {
    return this.dbService.singleTransaction<any>(
      'createSource',
      [accountType, accountNumber, networkId, beneficiaryId],
      enums.PAYMENT_QUERY
    );
  }

  async createWalletTransaction(
    id: string,
    status: string,
    reason: string,
    sendAmount: number,
    sendChannel: string,
    sendNetwork: string | null,
    beneficiaryId: string,
    userId: string,
    sourceId: string
  ): Promise<any> {
    return this.dbService.singleTransaction<any>(
      'createWalletTransaction',
      [
        id,
        status,
        reason,
        sendAmount,
        sendChannel,
        sendNetwork,
        beneficiaryId,
        userId,
        sourceId,
      ],
      enums.PAYMENT_QUERY
    );
  }

  async updateTransactionToPayment(
    collectionSequenceId: string,
    paymentSequenceId: string,
    sendChannel: string,
    sendNetwork: string,
    amount: number,
    reason: string
  ): Promise<any> {
    return this.dbService.singleTransaction<any>(
      'updateTransactionToPayment',
      [
        collectionSequenceId,
        'pending-payment',
        reason,
        amount,
        sendChannel,
        sendNetwork,
        paymentSequenceId,
        collectionSequenceId,
      ],
      enums.PAYMENT_QUERY
    );
  }

  async updateTransactionStatus(id: string, status: string): Promise<any> {
    return this.dbService.singleTransaction<any>(
      'updateWalletTransaction',
      [id, status],
      enums.PAYMENT_QUERY
    );
  }

  async updateTransactionPaymentStatus(
    id: string,
    status: string
  ): Promise<any> {
    const tx = await this.dbService.singleTransaction<{ status: string }>(
      'getWalletTransactionById',
      [id],
      enums.PAYMENT_QUERY
    );
    if (tx && String(tx.status) === status) {
      return tx;
    }
    const updated = await this.dbService.singleTransaction<any>(
      'updateWalletTransactionPayment',
      [id, status],
      enums.PAYMENT_QUERY
    );
    const row =
      updated ??
      (await this.dbService.singleTransaction<any>(
        'updateWalletTransactionPaymentByRef',
        [id, status],
        enums.PAYMENT_QUERY
      ));

    if (row && status === 'failed-payment') {
      await this.reverseFailedYellowCardSendIfNeeded(row).catch((err: unknown) => {
        console.warn(
          `[updateTransactionPaymentStatus] reversal skipped ref=${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }

    return row;
  }

  /** Credit USD back when a wallet-funded Yellow Card payout fails after debit. */
  private async reverseFailedYellowCardSendIfNeeded(tx: {
    user_id?: string;
    collection_sequence_id?: string | null;
    id?: string;
  }): Promise<void> {
    const userId = String(tx.user_id ?? '').trim();
    const collectionId =
      String(tx.collection_sequence_id ?? '').trim() ||
      (String(tx.id ?? '').startsWith('wt-')
        ? String(tx.id).slice(3)
        : '');
    if (!userId || !collectionId) return;

    await reverseYellowCardWalletDebit({
      userId,
      collectionSequenceId: collectionId,
      reason: 'yellowcard_payment_failed',
    });
  }

  async getUserBeneficiaries(
    userId: string,
    limit: number,
    offset: number
  ): Promise<any> {
    const beneficiariesQueryPromise = this.dbService.transact<any>(
      'getUserBeneficiaries',
      [userId, limit, offset],
      enums.PAYMENT_QUERY
    );

    const beneficiariesCountPromise =
      this.dbService.singleTransaction<TransactionCountResult>(
        'getUserBeneficiariesCount',
        [userId],
        enums.PAYMENT_QUERY
      );

    const [beneficiariesResult, beneficiariesCountResult] = await Promise.all([
      beneficiariesQueryPromise,
      beneficiariesCountPromise,
    ]);

    const totalCount = Number(beneficiariesCountResult?.total || 0);
    const totalPages = Math.ceil(totalCount / limit);
    const currentPage = Math.max(1, Math.floor(offset / limit) + 1);

    return {
      beneficiaries: beneficiariesResult,
      totalCount,
      totalPages,
      page: currentPage,
      limit,
    };
  }

  /**
   * Wallet-funded Yellow Card payout: debit unified USD ledger, then disburse locally.
   * Skips external YC collection — user already holds balance in-app.
   */
  async walletFundedYellowCardSend(
    params: {
      userId: string;
      sendAmount: number;
      payWithCurrency: string;
      feeUsd: number;
      receiveAmount: number;
      receiveCurrency: string;
      country: string;
      channelId: string;
      networkId: string;
      accountNumber: string;
      accountName: string;
      accountType: string;
      reason: string;
      bankName?: string;
      recipient: {
        name: string;
        country: string;
        phone: string;
        address: string;
        dob: string;
        email: string;
        idNumber: string;
        idType: string;
      };
    },
    yellowCardService: {
      createPaymentRequest: (payload: Record<string, unknown>) => Promise<unknown>;
      isConfigured: () => boolean;
    }
  ): Promise<{ collectionSequenceId: string; paymentSequenceId: string; payment: unknown }> {
    if (!yellowCardService.isConfigured()) {
      throw new Error('Yellow Card is not configured');
    }

    const payWith = String(params.payWithCurrency || PRIMARY_CURRENCY)
      .trim()
      .toUpperCase();
    const feeUsd = Number(params.feeUsd) || 0;
    const sendAmount = Number(params.sendAmount);
    const receiveAmount = Number(params.receiveAmount);
    const receiveCurrency = String(params.receiveCurrency).trim().toUpperCase();
    const reason = String(params.reason || 'other').toLowerCase();

    if (!Number.isFinite(sendAmount) || sendAmount <= 0) {
      throw new Error('Invalid send amount');
    }
    if (!Number.isFinite(receiveAmount) || receiveAmount <= 0) {
      throw new Error('Invalid receive amount');
    }

    const { usdAmount: sendUsd } = await convertAmountToUsd(sendAmount, payWith);

    /** Yellow Card minimum send (USD equivalent). Default $1. */
    const ycMinSendUsd = Number(process.env.YC_MIN_SEND_USD ?? 1);
    if (
      Number.isFinite(ycMinSendUsd) &&
      ycMinSendUsd > 0 &&
      sendUsd < ycMinSendUsd
    ) {
      throw new Error(
        `Minimum send amount is $${ycMinSendUsd.toFixed(2)}. Increase your amount and try again.`
      );
    }

    assertYellowCardSendWithinLimits({
      country: params.country,
      receiveCurrency: params.receiveCurrency,
      receiveAmount,
      channelId: params.channelId,
      networkId: params.networkId,
    });

    const ycLocalAmount = receiveAmount;
    const totalUsd = Number((sendUsd + feeUsd).toFixed(8));
    const usdWallet = await this.ensureUsdWallet(params.userId);
    const collectionSequenceId = crypto.randomUUID();
    const paymentSequenceId = crypto.randomUUID();
    const debitKey = buildIdempotencyKey('yc_send', collectionSequenceId);

    const ycNetworkId = await resolveYellowCardNetworkId({
      networkId: params.networkId,
      channelId: params.channelId,
      country: params.country,
    });

    const bankName =
      String(params.bankName ?? '').trim() ||
      (await resolveFlutterwaveBankName(params.networkId)) ||
      'Bank';

    const ycParty = await buildYellowCardSendPartyFields(params.userId);

    const activityTitle = `Send to ${params.accountName} · ${bankName}`;
    const fxRate =
      receiveCurrency === 'NGN' && receiveAmount > 0 && sendUsd > 0
        ? receiveAmount / sendUsd
        : undefined;

    await debitUsdBalance({
      userId: params.userId,
      walletId: usdWallet.wallet_id,
      amountUsd: totalUsd,
      source: 'yellowcard',
      idempotencyKey: debitKey,
      externalReference: collectionSequenceId,
      metadata: {
        payWithCurrency: payWith,
        sendAmount,
        feeUsd,
        receiveAmount,
        receiveCurrency,
        payoutCountry: params.country,
        channelId: params.channelId,
        networkId: ycNetworkId,
        accountName: params.accountName,
        bankName,
        activityTitle,
        ngnAmount: receiveCurrency === 'NGN' ? ycLocalAmount : undefined,
        rate: fxRate,
      },
    });

    const ycPayload = {
      sequenceId: paymentSequenceId,
      channelId: params.channelId,
      currency: receiveCurrency,
      country: params.country,
      localAmount: ycLocalAmount,
      reason,
      forceAccept: true,
      customerType: ycParty.customerType,
      customerUID: ycParty.customerUID,
      destination: {
        accountNumber: params.accountNumber,
        accountType: params.accountType,
        country: params.country,
        networkId: ycNetworkId,
        accountName: params.accountName,
        phoneNumber: normalizeRecipientPhone(
          params.recipient.phone,
          params.country
        ),
      },
      sender: ycParty.sender,
      metadata: {
        collectionSequenceId,
        fundSource: 'dayfi_wallet',
      },
    };

    try {
      const payment = await yellowCardService.createPaymentRequest(ycPayload);
      const txStatus = resolveYellowCardPaymentStatus(payment);

      await recordWalletActivity({
        userId: params.userId,
        id: buildWalletActivityTxId(collectionSequenceId),
        direction: 'debit',
        amount: sendUsd,
        currency: payWith,
        source: 'yellowcard',
        title: activityTitle,
        reason: activityTitle,
        channel: 'bank',
        status: txStatus,
        beneficiaryName: params.accountName,
        accountNumber: params.accountNumber,
        accountType: params.accountType,
        networkId: ycNetworkId,
        bankName,
        beneficiaryCountry: params.country,
        receiveAmount: ycLocalAmount,
        receiveCurrency,
        externalReference: paymentSequenceId,
        paymentSequenceId,
        collectionSequenceId,
      });

      if (txStatus === 'failed-payment') {
        await reverseYellowCardWalletDebit({
          userId: params.userId,
          collectionSequenceId,
          reason: 'yellowcard_create_failed',
        }).catch(() => undefined);
      }

      return { collectionSequenceId, paymentSequenceId, payment };
    } catch (err: unknown) {
      await creditUsdBalance({
        userId: params.userId,
        walletId: usdWallet.wallet_id,
        amount: totalUsd,
        fromCurrency: PRIMARY_CURRENCY,
        source: 'yellowcard',
        idempotencyKey: `${debitKey}-reversal`,
        externalReference: `${collectionSequenceId}-reversal`,
        metadata: {
          reversal: true,
          originalReference: collectionSequenceId,
        },
      }).catch(() => undefined);

      await recordWalletActivity({
        userId: params.userId,
        id: buildWalletActivityTxId(collectionSequenceId),
        direction: 'debit',
        amount: sendUsd,
        currency: payWith,
        source: 'yellowcard',
        title: activityTitle,
        reason: activityTitle,
        channel: 'bank',
        status: 'failed-payment',
        beneficiaryName: params.accountName,
        accountNumber: params.accountNumber,
        accountType: params.accountType,
        networkId: ycNetworkId,
        bankName,
        beneficiaryCountry: params.country,
        receiveAmount: ycLocalAmount,
        receiveCurrency,
        externalReference: paymentSequenceId,
      }).catch(() => undefined);

      await safeNotify(
        () =>
          notifyBankSendFailed({
            userId: params.userId,
            amount: sendUsd,
            currency: payWith,
            recipientName: params.accountName,
            bankName,
            reference: collectionSequenceId,
            reason: err instanceof Error ? err.message : String(err),
          }),
        'bank_send_failed'
      );

      throw err;
    }
  }
}

export default PaymentService;
