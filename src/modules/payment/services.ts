import {
  fetchBanks,
  resolveBankDetails,
  chargeCard,
  initiateTransfer,
  createVirtualAccount,
  chargeCardWithToken,
  verifyCharge,
  verifyPayment,
} from './flutterwaveService';
import DBService, { queries } from '../../shared/services/db.service';
import enums from '../../shared/lib/enums';
import config from '../../config/env';

type TransactionCountResult = { total: string | number };

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

      return {
        success: true,
        accountName: response.data.data.account_name,
        accountNumber: response.data.data.account_number,
        bankCode: bankCode,
      };
    } catch (error: any) {
      console.error('Error resolving bank account:', error.message);
      throw new Error(
        'Unable to verify account details at this time. Please try again.'
      );
    }
  }

  async fetchBanks(): Promise<any> {
    const response = await fetchBanks();
    return response.data;
  }

  async createCustomerAndVirtualAccount(
    userId: string,
    email: string,
    bvn: string,
    userName: string
  ): Promise<any> {
    try {
      const accountResponse = await createVirtualAccount(email, bvn);
      const accountData = accountResponse.data.data;

      const walletRecord = await this.dbService.singleTransaction(
        'createWallet',
        [
          userId,
          accountData.flw_reference,
          userName,
          accountData.accountnumber,
          accountData.bankcode || 0,
          accountData.bankname,
          accountData.currency || 'NGN',
        ],
        enums.PAYMENT_QUERY
      );

      return {
        success: true,
        wallet: walletRecord,
      };
    } catch (error: any) {
      console.error(
        'Error creating customer and virtual account:',
        error.message
      );
      throw new Error('Unable to create customer and virtual account');
    }
  }

  async transferToVirtualAccount(
    amount: number,
    name: string,
    accountNumber: string,
    bankCode: string,
    bankName: string,
    userId: string,
    walletId: string,
    balance: number,
    recipient: string
  ): Promise<any> {
    try {
      const reference = `tx-ref-${Date.now()}`;
      const narration = 'Transfer to virtual account';
      const meta = {
        FirstName: name.split(' ')[0],
        LastName: name.split(' ')[1] || '',
      };

      const response = await initiateTransfer(
        bankCode,
        accountNumber,
        amount,
        narration,
        'NGN',
        reference,
        name,
        meta
      );

      await this.dbService.singleTransaction(
        'createWalletTransaction',
        [
          userId,
          walletId,
          recipient,
          accountNumber,
          bankCode,
          bankName,
          amount,
          balance,
          0,
          'wallet_to_wallet',
          'pending',
          reference,
          `Sending money via wallet`,
          {},
          userId,
        ],
        enums.PAYMENT_QUERY
      );

      return {
        success: true,
        transferCode: reference,
        response: response,
        message: 'Transfer initiated successfully',
      };
    } catch (error: any) {
      console.error(
        'Error transferring to virtual account:',
        error?.response?.data || error.message
      );
      throw new Error('Unable to transfer funds at this time');
    }
  }

  async bankTransfer(
    amount: number,
    accountName: string,
    accountNumber: string,
    bankCode: string,
    bankName: string,
    fee: string,
    userId: string,
    walletId: string,
    balance: number
  ): Promise<any> {
    try {
      const reference = `tx-ref-${Date.now()}` + '_PMCKDU_1';
      const narration = 'Bank Transfer';
      const meta = {
        FirstName: accountName.split(' ')[0],
        LastName: accountName.split(' ')[1] || '',
      };

      const response = await initiateTransfer(
        bankCode,
        accountNumber,
        amount,
        narration,
        'NGN',
        reference,
        accountName,
        meta
      );

      console.log(response);

      await this.dbService.singleTransaction(
        'createWalletTransaction',
        [
          userId,
          walletId,
          null,
          accountNumber,
          bankCode,
          bankName,
          amount,
          balance,
          fee,
          'wallet_to_bank',
          'pending',
          reference,
          `Sending money via wallet`,
          {},
          userId,
        ],
        enums.PAYMENT_QUERY
      );

      return {
        success: true,
        transferCode: reference,
        response: response,
        message: 'Transfer initiated successfully',
      };
    } catch (error: any) {
      console.error(
        'Error transferring to virtual account:',
        error?.response?.data || error.message
      );
      throw new Error('Unable to transfer funds at this time');
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
    return await this.dbService.singleTransaction(
      'getWalletByDayfiId',
      [dayfiId],
      enums.PAYMENT_QUERY
    );
  }

  async getWalletByUserId(userId: string): Promise<any> {
    return await this.dbService.singleTransaction(
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
    return await this.dbService.singleTransaction(
      'updateWalletWithDayfiId',
      [dayfiId, userId],
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

    const countRow = transactionCountResult[0] as TransactionCountResult;
    const totalCount = Number(countRow?.total || 0);
    const totalPages = Math.ceil(totalCount / limit);
    const currentPage = Math.max(1, Math.floor(offset / limit) + 1);

    return {
      transactions: transactionsResult,
      totalCount,
      totalPages,
      page: currentPage,
      limit,
    };
  }

  async createWallet(userId: string, currency: string): Promise<Wallet | null> {
    const reference = `wallet-ref-${Date.now()}`;
    return this.dbService.singleTransaction<any>(
      'createOtherWallet',
      [userId, reference, currency, 'dummy'],
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
    const result = await this.dbService.singleTransaction<any>(
      'fetchExchangeRate',
      [base, target],
      enums.PAYMENT_QUERY
    );

    if (!result?.rate) {
      throw new Error(`No exchange rate from ${base} to ${target}`);
    }

    return Number(result.rate);
  }

  async swapCurrency(
    userId: string,
    fromCurrency: string,
    toCurrency: string,
    amount: number
  ): Promise<any> {
    if (fromCurrency === toCurrency) {
      throw new Error('Cannot swap the same currency');
    }

    const fromWallet = await this.dbService.singleTransaction<any>(
      'getUserWalletByCurrency',
      [userId, fromCurrency],
      enums.PAYMENT_QUERY
    );

    const toWallet = await this.dbService.singleTransaction<any>(
      'getUserWalletByCurrency',
      [userId, toCurrency],
      enums.PAYMENT_QUERY
    );

    if (!fromWallet || !toWallet) {
      throw new Error('Wallet not found for one or both currencies');
    }

    if (fromWallet.balance < amount) {
      throw new Error('Insufficient balance in source wallet');
    }

    const exchangeRate = await this.dbService.singleTransaction<any>(
      'fetchExchangeRate',
      [fromCurrency, toCurrency],
      enums.PAYMENT_QUERY
    );

    if (!exchangeRate?.rate) {
      throw new Error(`No exchange rate from ${fromCurrency} to ${toCurrency}`);
    }

    const rate = Number(exchangeRate.rate);
    const convertedAmount = Number((amount * rate).toFixed(2));

    await this.dbService.nestedTransaction([
      {
        query: queries[enums.PAYMENT_QUERY].debitWallet,
        payload: [amount, fromWallet.wallet_id],
      },
      {
        query: queries[enums.PAYMENT_QUERY].creditWallet,
        payload: [convertedAmount, toWallet.wallet_id],
      },
      {
        query: queries[enums.PAYMENT_QUERY].logSwap,
        payload: [
          userId,
          fromWallet.wallet_id,
          toWallet.wallet_id,
          fromCurrency,
          toCurrency,
          amount,
          rate,
          convertedAmount,
        ],
      },
    ]);

    const reference = `tx-ref-${Date.now()}`;

    await this.dbService.singleTransaction(
      'createWalletTransaction',
      [
        userId,
        fromWallet.wallet_id,
        toWallet.wallet_id,
        toWallet.account_number,
        toWallet.bank_code,
        toWallet.bank_name,
        amount,
        fromWallet.balance,
        null,
        'wallet_to_wallet',
        'success',
        reference,
        `Sending money via wallet`,
        {},
        userId,
      ],
      enums.PAYMENT_QUERY
    );

    return {
      success: true,
      message: 'Currency swapped successfully',
      rate,
      convertedAmount,
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
    return this.dbService.singleTransaction<any>(
      'updateWalletTransactionPayment',
      [id, status],
      enums.PAYMENT_QUERY
    );
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
}

export default PaymentService;
