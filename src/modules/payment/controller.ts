import { Request, Response } from 'express';
import PaymentService from './services';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import YellowCardService from './yellowCardService';
import GreyService from './greyService';
import config from '../../config/env';
import {
  PRIMARY_CURRENCY,
  formatGreyAccountsList,
  formatPrdWalletDetails,
} from './walletModel';
import { sumBalancesToUsd } from './fxService';
import {
  enqueueCryptoWalletProvision,
  provisionCryptoWalletsForUser,
  buildReceiveCryptoPayload,
  getCryptoWalletProvisionJob,
  getRecoveryMnemonicForUser,
} from './cryptoWalletProvision';
import {
  getCryptoBalances,
  getCryptoSendConfig,
  routeCryptoSend,
} from './cryptoSendService';
import { recordCryptoOutboundLedger } from './cryptoOutboundLedgerService';
import { syncStellarInflowsToLedger } from './cryptoInflowSyncService';
import { getPayoutQuote } from './payoutQuoteService';
import { getUserFeatureActivity } from './featureActivityService';
import {
  acceptInvestmentRisk,
  claimInvestmentPosition,
  depositToInvestment,
  getInvestmentPlans,
  getInvestmentSummary,
  listInvestmentPositions,
  quoteInvestment,
  withdrawFromInvestment,
} from './investmentService';
import {
  computeInterestPreview,
  createDayEarnPot,
  depositToDayEarnPot,
  getDayEarnPotDetail,
  getDayEarnSummary,
  renameDayEarnPot,
  withdrawFromDayEarnPot,
} from './dayearnService';
import {
  listSavedRecipients,
  upsertSavedRecipient,
} from './savedRecipientService';
import { db } from '../../config/database';

class PaymentController {
  private readonly paymentService: PaymentService;
  private readonly yellowCardService: YellowCardService;
  private readonly greyService: GreyService;

  constructor() {
    this.paymentService = new PaymentService();
    this.yellowCardService = new YellowCardService();
    this.greyService = new GreyService();
  }

  fetchBanks = async (_req: Request, res: Response): Promise<any> => {
    try {
      const banks = await this.paymentService.fetchBanks();

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Banks'),
        enums.HTTP_OK,
        banks
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  /** Flutterwave NG banks as network rows (for send recipient picker). */
  fetchNigerianBanks = async (_req: Request, res: Response): Promise<any> => {
    try {
      const networks = await this.paymentService.fetchNigerianBankNetworks();
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Nigerian banks'),
        enums.HTTP_OK,
        { networks }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  resolveBankAccount = async (req: Request, res: Response): Promise<any> => {
    try {
      const { accountNumber, bankCode } = req.body;

      const resolvedAccount = await this.paymentService.resolveBankAccount(
        accountNumber,
        bankCode
      );

      return success(
        res,
        'Bank account resolved successfully',
        enums.HTTP_OK,
        resolvedAccount
      );
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  chargeUserCard = async (req: Request, res: Response): Promise<any> => {
    try {
      const chargePayload = req.body;
      const { user } = req;
      await this.paymentService.ensureUsdWallet(user?.user_id);
      const wallet = await this.paymentService.getWalletByUserId(user?.user_id);
      if (!wallet) {
        return errorResponse(res, 'Wallet not found', enums.HTTP_NOT_FOUND);
      }

      const response = await this.paymentService.chargeUserCard({
        ...chargePayload,
        userId: user?.user_id,
        walletId: wallet.wallet_id,
      });

      return success(res, 'Card charged successfully', enums.HTTP_OK, response);
    } catch (err: any) {
      return errorResponse(
        res,
        err.message || 'Unable to charge card',
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  verifyCardCharge = async (req: Request, res: Response): Promise<any> => {
    try {
      const chargePayload = req.body;

      const response = await this.paymentService.verifyCharge(chargePayload);

      return success(
        res,
        'Card charge verified successfully',
        enums.HTTP_OK,
        response
      );
    } catch (err: any) {
      return errorResponse(
        res,
        err.message || 'Unable to verify card charge',
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  verifyPayment = async (req: Request, res: Response): Promise<any> => {
    try {
      const payload = req.body;

      const response = await this.paymentService.verifyPayment(payload);

      return success(
        res,
        'Payment verified successfully',
        enums.HTTP_OK,
        response
      );
    } catch (err: any) {
      return errorResponse(
        res,
        err.message || 'Unable to verify payment',
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  chargeUserWithToken = async (req: Request, res: Response): Promise<any> => {
    try {
      const chargeTokenPayload = req.body;

      const response = await this.paymentService.chargeUserWithToken(
        chargeTokenPayload
      );

      return success(
        res,
        'Tokenized charge successful',
        enums.HTTP_OK,
        response
      );
    } catch (err: any) {
      return errorResponse(
        res,
        err.message || 'Unable to charge with token',
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  /** PRD alias: GET /payments/wallets/balances */
  getWalletBalances = async (req: Request, res: Response): Promise<any> =>
    this.getWalletDetails(req, res);

  getWalletDetails = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      const userId = user?.user_id as string;

      const walletsByCurrency = await this.paymentService.ensureUserLedgerWallets(
        userId
      );

      // Ensure deposit address exists before reading Horizon inflows.
      try {
        await provisionCryptoWalletsForUser(userId);
      } catch (provisionErr: unknown) {
        console.warn(
          `[getWalletDetails] crypto provision skipped for user=${userId}: ${
            provisionErr instanceof Error
              ? provisionErr.message
              : String(provisionErr)
          }`
        );
      }

      let stellarSync: Awaited<ReturnType<typeof syncStellarInflowsToLedger>> | null =
        null;
      let stellarDepositAddress: string | null = null;

      // Keep app balances in sync with inbound Stellar testnet/mainnet deposits.
      try {
        const addrRow = await db.oneOrNone<{ stellar_deposit_address: string | null }>(
          `SELECT stellar_deposit_address FROM wallets
           WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
          [userId]
        );
        stellarDepositAddress = addrRow?.stellar_deposit_address ?? null;

        stellarSync = await syncStellarInflowsToLedger({
          userId,
          walletsByCurrency,
        });
        if (
          stellarSync.errors.length > 0 ||
          (stellarSync.processed > 0 && stellarSync.credited === 0)
        ) {
          console.warn(
            `[getWalletDetails] stellar sync user=${userId} address=${stellarDepositAddress} ${JSON.stringify(stellarSync)}`
          );
        }
      } catch (syncErr: unknown) {
        console.warn(
          `[getWalletDetails] stellar sync skipped for user=${userId}: ${
            syncErr instanceof Error ? syncErr.message : String(syncErr)
          }`
        );
      }

      const wallets = await this.paymentService.getWalletsByUserId(
        userId
      );

      const totalUsd = await sumBalancesToUsd(
        wallets.map((w: any) => ({
          currency: w.currency,
          balance: Number(w.balance ?? 0),
        }))
      );
      const data = {
        ...formatPrdWalletDetails(wallets as any, totalUsd),
        stellarReceive: {
          address: stellarDepositAddress,
          network: process.env.STELLAR_NETWORK || 'testnet',
          sync: stellarSync,
        },
      };

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Wallets details'),
        enums.HTTP_OK,
        data
      );
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  addDayfiId = async (req: Request, res: Response): Promise<any> => {
    try {
      const { dayfiId } = req.body;
      const user = req.user;

      await this.paymentService.ensurePrimaryWallet(user?.user_id);

      const wallet = await this.paymentService.addDayfiId(
        dayfiId,
        user?.user_id
      );

      if (!wallet) {
        return errorResponse(
          res,
          'No wallet found for this account. Complete profile onboarding so a wallet can be created before setting a Dayfi Tag.',
          enums.HTTP_BAD_REQUEST
        );
      }

      return success(res, 'Dayfi Id added successfully', enums.HTTP_OK, user);
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  fetchDayfiId = async (req: Request, res: Response): Promise<any> => {
    try {
      const { dayfiId } = req.params;

      const wallet = await this.paymentService.getWalletByDayfiId(dayfiId);
      if (!wallet) {
        return errorResponse(res, 'Invalid dayfi ID', enums.HTTP_BAD_REQUEST);
      }

      const userRow = await db.oneOrNone<{
        first_name: string | null;
        last_name: string | null;
      }>(
        `SELECT first_name, last_name FROM users WHERE user_id = $1 LIMIT 1`,
        [wallet.user_id]
      );

      const fullName =
        `${userRow?.first_name ?? ''} ${userRow?.last_name ?? ''}`.trim();
      const accountName =
        String(wallet.account_name ?? '').trim() || fullName || null;

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Dayfi id'),
        enums.HTTP_OK,
        {
          ...wallet,
          first_name: userRow?.first_name ?? null,
          last_name: userRow?.last_name ?? null,
          account_name: accountName,
        }
      );
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  transferToVirtualAccount = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const { amount, dayfiId } = req.body;
      const user = req.user;
      const wallet = (req as any).wallet;
      const recipient = await this.paymentService.getWalletByDayfiId(dayfiId);
      if (!recipient) {
        return errorResponse(res, 'Recipient Dayfi tag not found', enums.HTTP_NOT_FOUND);
      }

      const currency = String(
        (req as any).debitCurrency ?? wallet.currency ?? PRIMARY_CURRENCY
      ).toUpperCase();

      const result = await this.paymentService.transferP2p(
        user?.user_id,
        wallet.wallet_id,
        dayfiId,
        amount,
        currency
      );

      return success(
        res,
        'Transfer completed successfully',
        enums.HTTP_OK,
        result
      );
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  bankTransfer = async (req: Request, res: Response): Promise<any> => {
    try {
      const {
        amount,
        bankCode,
        accountNumber,
        accountName,
        bankName,
        fee,
        spendCurrency = 'NGN',
      } = req.body;
      const user = req.user;
      const wallet = (req as any).wallet;

      if (
        String(spendCurrency).toUpperCase() === PRIMARY_CURRENCY &&
        !this.greyService.isConfigured()
      ) {
        return errorResponse(
          res,
          'USD bank payouts require Grey. Use spendCurrency NGN for legacy Nigeria transfers, or configure DAYFI_GREY_*.',
          enums.HTTP_BAD_REQUEST
        );
      }

      const resolvedAccount = await this.paymentService.bankTransfer(
        amount,
        accountName,
        accountNumber,
        bankCode,
        bankName,
        fee,
        user?.user_id,
        wallet.wallet_id,
        spendCurrency
      );

      return success(
        res,
        'Bank transfer initiated successfully',
        enums.HTTP_OK,
        resolvedAccount
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        /insufficient|invalid|flutterwave|bank code|account/i.test(msg)
          ? enums.HTTP_BAD_REQUEST
          : enums.HTTP_INTERNAL_SERVER_ERROR;
      return errorResponse(res, msg, status);
    }
  };

  fetchWalletTransactions = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const user = req.user;

      const {
        status = null,
        startDate = null,
        endDate = null,
        search = null,
        limit = 10,
        page = 1,
        sortOrder,
      } = req.query;

      const limitNum = Math.max(1, Number(limit));
      const offset = (Math.max(1, Number(page)) - 1) * limitNum;

      const transactions = await this.paymentService.fetchWalletTransactions(
        user?.user_id,
        status as string | null,
        startDate as string | null,
        endDate as string | null,
        search as string | null,
        limitNum,
        offset,
        sortOrder as string | null
      );

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Wallet transactions'),
        enums.HTTP_OK,
        transactions
      );
    } catch (err: any) {
      console.error('Error fetching wallet transactions:', err.message);
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getFeatureActivity = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      const activity = await getUserFeatureActivity(user?.user_id);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Feature activity'),
        enums.HTTP_OK,
        activity
      );
    } catch (err: any) {
      console.error('Error fetching feature activity:', err.message);
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getUserBeneficiaries = async (req: Request, res: Response): Promise<any> => {
    try {
      const { user } = req;
      const { limit = 100, page = 1 } = req.query;

      const limitNum = Math.max(1, Math.min(200, Number(limit)));
      const offset = (Math.max(1, Number(page)) - 1) * limitNum;

      const result = await listSavedRecipients(
        user?.user_id,
        limitNum,
        offset
      );

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Beneficiaries'),
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  saveBeneficiary = async (req: Request, res: Response): Promise<any> => {
    try {
      const { user } = req;
      const body = req.validatedBody as {
        name: string;
        country: string;
        phone?: string;
        ledgerCurrency: string;
        source: {
          accountType: string;
          accountNumber: string;
          networkId?: string;
        };
      };

      const recipient = await upsertSavedRecipient(user?.user_id, body);

      return success(
        res,
        enums.CREATED_SUCCESSFULLY('Beneficiary'),
        enums.HTTP_CREATED,
        recipient
      );
    } catch (err: any) {
      return errorResponse(
        res,
        err.message,
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }
  };

  processWebhookData = async (req: Request, res: Response): Promise<any> => {
    try {
      console.log(req.body, 'yoooo');
      const { transfer } = req.body;

      const transactionReference = transfer.reference;
      const status = transfer.status;
      const amount = transfer.amount;
      const fee = transfer.fee;

      if (!transactionReference || !status || amount == null) {
        return errorResponse(
          res,
          'Invalid webhook data',
          enums.HTTP_BAD_REQUEST
        );
      }

      await this.paymentService.verifyTransfer({
        transactionReference,
        status,
        amount,
        fee,
      });

      return res
        .status(200)
        .json({ message: 'Webhook processed successfully' });
    } catch (err: any) {
      console.error('Webhook processing error:', err.message);
      console.error('Webhook payload:', JSON.stringify(req.body, null, 2));
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  createWallet = async (req: Request, res: Response): Promise<void> => {
    try {
      const payload = req.body;
      const { user } = req;

      const data = await this.paymentService.ensureWalletForCurrency(
        user?.user_id,
        payload.currency
      );
      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: Wallet created successfully`
      );
      success(res, enums.CREATED_SUCCESSFULLY('Wallet'), enums.HTTP_OK, data);
    } catch (err) {
      console.error(`Error occurred while creating wallet: ${err.message}`);
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  createExchangeRate = async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        baseCurrency,
        targetCurrency,
        rate,
        source = 'manual',
      } = req.body;

      const data = await this.paymentService.createExchangeRate(
        baseCurrency,
        targetCurrency,
        rate,
        source
      );

      console.log(`${enums.CURRENT_TIME_STAMP}, Info: Exchange rate created`);
      success(
        res,
        enums.CREATED_SUCCESSFULLY('Exchange rate'),
        enums.HTTP_OK,
        data
      );
    } catch (err: any) {
      console.error(
        `Error occurred while creating exchange rate: ${err.message}`
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getExchangeRate = async (req: Request, res: Response): Promise<void> => {
    try {
      const { baseCurrency, targetCurrency } =
        (req as any).validatedQuery ?? req.query;

      const rate = await this.paymentService.getExchangeRate(
        String(baseCurrency),
        String(targetCurrency)
      );

      console.log(`${enums.CURRENT_TIME_STAMP}, Info: Exchange rate fetched`);
      success(res, 'Exchange rate fetched', enums.HTTP_OK, { rate });
    } catch (err: any) {
      console.error(
        `Error occurred while fetching exchange rate: ${err.message}`
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getWalletExchangeRates = async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getWalletExchangeRateMatrix } = await import('./fxRateSyncService');
      const matrix = await getWalletExchangeRateMatrix();
      success(res, 'Wallet exchange rates', enums.HTTP_OK, matrix);
    } catch (err: any) {
      console.error(`Wallet exchange rates error: ${err.message}`);
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  swapCurrency = async (req: Request, res: Response): Promise<void> => {
    try {
      const { fromCurrency, toCurrency, amount } = req.body;
      const { user } = req;

      const result = await this.paymentService.swapCurrency(
        user?.user_id,
        fromCurrency,
        toCurrency,
        Number(amount)
      );

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: Currency swap successful`
      );
      success(res, 'Currency swapped successfully', enums.HTTP_OK, result);
    } catch (err: any) {
      console.error(`Error occurred while swapping currency: ${err.message}`);
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  fetchChannels = async (_req: Request, res: Response): Promise<any> => {
    try {
      const channels = await this.yellowCardService.fetchChannels();
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Channels'),
        enums.HTTP_OK,
        channels
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  fetchNetworks = async (_req: Request, res: Response): Promise<any> => {
    try {
      // NGN bank payouts use Flutterwave — prefer FW bank list; Yellow Card as fallback.
      let networks: unknown[] = [];
      try {
        networks = await this.paymentService.fetchNigerianBankNetworks();
      } catch (fwErr: unknown) {
        console.warn(
          `[fetchNetworks] Flutterwave banks unavailable: ${
            fwErr instanceof Error ? fwErr.message : String(fwErr)
          }`
        );
      }

      if (!networks.length) {
        try {
          const yc = await this.yellowCardService.fetchNetworks();
          const raw = (yc as { networks?: unknown[] })?.networks ?? yc;
          if (Array.isArray(raw)) networks = raw;
        } catch (ycErr: unknown) {
          console.warn(
            `[fetchNetworks] Yellow Card unavailable: ${
              ycErr instanceof Error ? ycErr.message : String(ycErr)
            }`
          );
        }
      }

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Networks'),
        enums.HTTP_OK,
        { networks }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  fetchExchangeRates = async (req: Request, res: Response): Promise<any> => {
    try {
      const currency = String(req.query.currency ?? 'NGN')
        .trim()
        .toUpperCase();

      // Domestic NGN does not need Yellow Card FX.
      if (currency === 'NGN') {
        return success(
          res,
          enums.FETCHED_SUCCESSFULLY('Exchange Rates'),
          enums.HTTP_OK,
          {
            currency: 'NGN',
            rate: 1,
            buy: 1,
            sell: 1,
            source: 'platform',
          }
        );
      }

      try {
        const rates = await this.yellowCardService.fetchExchangeRates(currency);
        return success(
          res,
          enums.FETCHED_SUCCESSFULLY('Exchange Rates'),
          enums.HTTP_OK,
          rates
        );
      } catch (ycErr: unknown) {
        console.warn(
          `[fetchExchangeRates] Yellow Card unavailable: ${
            ycErr instanceof Error ? ycErr.message : String(ycErr)
          }`
        );
        return success(
          res,
          enums.FETCHED_SUCCESSFULLY('Exchange Rates'),
          enums.HTTP_OK,
          {
            currency,
            rate: 1,
            buy: 1,
            sell: 1,
            source: 'fallback',
          }
        );
      }
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  /** Feature flags + Yellow Card readiness for mobile (stablecoin top-up, etc.). */
  getPaymentCapabilities = async (_req: Request, res: Response): Promise<any> => {
    try {
      const yellowCardReady = this.yellowCardService.isConfigured();
      const greyReady = this.greyService.isConfigured();
      const stablecoinTopup =
        Boolean(
          (config as { STABLECOIN_TOPUP_ENABLED?: boolean }).STABLECOIN_TOPUP_ENABLED
        ) && yellowCardReady;

      return success(res, enums.FETCHED_SUCCESSFULLY('Payment capabilities'), enums.HTTP_OK, {
        primaryCurrency: PRIMARY_CURRENCY,
        stablecoinTopup,
        yellowCardReady,
        greyReady,
        fincraReady: false,
        stellarDeposits: Boolean(process.env.WALLET_ENCRYPTION_KEY),
        investmentPocket: true,
        receiveUsBank: true,
        receiveCrypto: true,
        localSpendNgn: true,
        tapToPay: false,
        virtualNairaCard: false,
      });
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  /**
   * Crypto / stablecoin channels from Yellow Card (same source as /channels).
   * Normalized to `{ channels: [...] }` for the mobile PaymentData parser.
   */
  fetchCryptoChannels = async (_req: Request, res: Response): Promise<any> => {
    try {
      if (!this.yellowCardService.isConfigured()) {
        return success(
          res,
          'Yellow Card is not configured; returning empty channel list',
          enums.HTTP_OK,
          { channels: [] }
        );
      }

      const raw = await this.yellowCardService.fetchChannels();
      let list: any[] = [];
      if (Array.isArray(raw)) {
        list = raw;
      } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).channels)) {
        list = (raw as any).channels;
      } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).data)) {
        list = (raw as any).data;
      }

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Crypto channels'),
        enums.HTTP_OK,
        { channels: list }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  createCollectionRequest = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const {
        amount,
        currency,
        channelId,
        channelName,
        country,
        reason,
        recipient,
        source,
      } = req.body;

      const beneficiary = await this.paymentService.createBeneficiary(
        recipient.name,
        recipient.country,
        recipient.phone,
        recipient.address,
        recipient.dob,
        recipient.email,
        recipient.idNumber,
        recipient.idType,
        req.user?.user_id
      );

      const savedSource = await this.paymentService.createSource(
        source.accountType,
        source.accountNumber,
        source.networkId,
        beneficiary.id
      );

      const sequenceId = crypto.randomUUID();
      const payload = {
        sequenceId,
        channelId,
        currency,
        country,
        reason: reason || 'other',
        localAmount: amount,
        forceAccept: true,
        recipient,
        source,
      };

      const collection = await this.yellowCardService.createCollectionRequest(
        payload
      );

      const transaction = await this.paymentService.createWalletTransaction(
        sequenceId,
        'pending-collection',
        reason || 'other',
        amount,
        channelName,
        source?.networkId || null,
        beneficiary.id,
        req.user?.user_id,
        savedSource.id
      );
      console.log(transaction);

      return success(
        res,
        enums.CREATED_SUCCESSFULLY('Collection Request'),
        enums.HTTP_CREATED,
        collection
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  createPaymentRequest = async (req: Request, res: Response): Promise<any> => {
    try {
      const {
        amount,
        currency,
        channelId,
        country,
        reason,
        accountNumber,
        networkId,
        accountType,
        networkCountry,
        accountName,
        metadata,
        collectionSequenceId,
      } = req.body;

      const paymentSequenceId = crypto.randomUUID();

      const payload = {
        sequenceId: paymentSequenceId,
        channelId,
        currency,
        country,
        localAmount: amount,
        reason,
        forceAccept: true,
        destination: {
          accountNumber,
          accountType,
          country: networkCountry,
          networkId,
          accountName,
        },
        sender: {
          name: req.user?.first_name + ' ' + req.user?.last_name,
          email: req.user?.email,
          phone: req.user?.phone_number,
          country: country,
        },
        metadata,
      };

      const payment = await this.yellowCardService.createPaymentRequest(
        payload
      );

      await this.paymentService.updateTransactionToPayment(
        collectionSequenceId,
        paymentSequenceId,
        channelId,
        networkId,
        amount,
        reason
      );

      return success(
        res,
        enums.CREATED_SUCCESSFULLY('Payment Request'),
        enums.HTTP_CREATED,
        payment
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  resolveBankDetailsYC = async (req: Request, res: Response): Promise<any> => {
    try {
      const { accountNumber, networkId, bankCode } = req.body;
      const fwBankCode = String(bankCode || networkId || '').trim();

      // Nigeria domestic: Flutterwave V3 account resolve (primary for NGN bank transfers).
      if (fwBankCode && /^\d{3,6}$/.test(fwBankCode)) {
        const resolved = await this.paymentService.resolveBankAccount(
          accountNumber,
          fwBankCode
        );
        return success(
          res,
          'Bank account resolved successfully',
          enums.HTTP_OK,
          {
            accountName: resolved.accountName,
            accountNumber: resolved.accountNumber,
            bankCode: resolved.bankCode,
            bankName: resolved.bankName,
          }
        );
      }

      // Yellow Card fallback when Flutterwave bank code is unavailable.
      try {
        const bankDetails = await this.yellowCardService.resolveBankDetailsYC(
          accountNumber,
          networkId
        );
        return success(
          res,
          enums.FETCHED_SUCCESSFULLY('Bank Details'),
          enums.HTTP_OK,
          bankDetails
        );
      } catch (ycErr: unknown) {
        throw new Error(
          ycErr instanceof Error
            ? ycErr.message
            : 'Unable to resolve bank account. Select a bank from the list and try again.'
        );
      }
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  createWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const { url, state } = req.body;
      const webhook = await this.yellowCardService.createWebhook(url, state);

      return success(
        res,
        enums.CREATED_SUCCESSFULLY('Webhook'),
        enums.HTTP_CREATED,
        webhook
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  fetchWebhooks = async (_req: Request, res: Response): Promise<any> => {
    try {
      const webhooks = await this.yellowCardService.fetchWebhooks();

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Webhooks'),
        enums.HTTP_OK,
        webhooks
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  updateWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const { id, active, url, state } = req.body;
      const webhook = await this.yellowCardService.updateWebhook(
        id,
        active,
        url,
        state
      );

      return success(
        res,
        enums.UPDATED_SUCCESSFULLY('Webhook'),
        enums.HTTP_OK,
        webhook
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  removeWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const { id } = req.params;
      const response = await this.yellowCardService.removeWebhook(id);

      return success(
        res,
        enums.DELETED_SUCCESSFULLY('Webhook'),
        enums.HTTP_OK,
        response
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  fetchFees = async (_req: Request, res: Response): Promise<any> => {
    return success(res, enums.FETCHED_SUCCESSFULLY('Fees'), enums.HTTP_OK, {
      transfer: { dayfi_to_dayfi: 0, dayfi_to_bank: 10 },
      withdrawal: { local: 0, international: 0 },
    });
  };

  startWalletProvision = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      const out = await enqueueCryptoWalletProvision(user?.user_id as string);
      if (out.status === 'completed') {
        return success(
          res,
          'Crypto wallets already provisioned',
          enums.HTTP_OK,
          {
            status: 'completed',
            current_step: 'finalize',
            job_id: out.job_id,
          }
        );
      }
      return success(res, 'Wallet provisioning started', enums.HTTP_OK, {
        job_id: out.job_id,
      });
    } catch (err: any) {
      return errorResponse(
        res,
        err?.message || 'Unable to start provisioning',
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  getWalletProvisionStatus = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      const { jobId } = req.params;
      const data = getCryptoWalletProvisionJob(jobId, user?.user_id as string);
      if (!data) {
        return errorResponse(res, 'Job not found', enums.HTTP_NOT_FOUND);
      }
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Provision status'),
        enums.HTTP_OK,
        data
      );
    } catch (err: any) {
      return errorResponse(
        res,
        err?.message || 'Unable to read status',
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  getWalletRecoveryPhrase = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const mnemonic = await getRecoveryMnemonicForUser(userId);
      if (!mnemonic) {
        return errorResponse(
          res,
          'No recovery phrase found for this account',
          enums.HTTP_NOT_FOUND
        );
      }
      const words = mnemonic.split(/\s+/).filter(Boolean);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Recovery phrase'),
        enums.HTTP_OK,
        { words, phrase: mnemonic }
      );
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : 'Unable to load recovery phrase',
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  /** Receive flow: US Bank Account (Grey USD account). */
  getReceiveUsBank = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      await this.paymentService.ensureUserLedgerWallets(user?.user_id);
      const accountName =
        `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim() || 'Dayfi User';
      const usdVa = await this.greyService.ensureVirtualAccount({
        userId: user?.user_id,
        currency: 'USD',
        accountName,
      });
      const allAccounts = await this.greyService.listVirtualAccounts(
        user?.user_id
      );
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('US bank receive details'),
        enums.HTTP_OK,
        {
          method: 'us_bank',
          provider: 'grey',
          currency: 'USD',
          virtualAccount: usdVa,
          accounts: allAccounts,
          rails: ['ACH', 'SWIFT', 'Fedwire'],
          creditsTo: PRIMARY_CURRENCY,
          kybNote:
            'Complete KYB in Grey dashboard to activate account numbers for deposits.',
        }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  /** Grey Accounts tab: USD, GBP, EUR, NGN (matches Grey sandbox UI). */
  getGreyAccounts = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      await this.paymentService.ensureUserLedgerWallets(user?.user_id);
      const accountName =
        `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim() || 'Dayfi User';
      const currencies: Array<'USD' | 'EUR' | 'GBP' | 'NGN'> = [
        'USD',
        'GBP',
        'EUR',
        'NGN',
      ];
      const accountsRaw = await Promise.all(
        currencies.map((currency) =>
          this.greyService.ensureVirtualAccount({
            userId: user?.user_id,
            currency,
            accountName,
          })
        )
      );
      const wallets = await this.paymentService.getWalletsByUserId(user?.user_id);
      const accounts = formatGreyAccountsList(accountsRaw, wallets as any);
      const totalUsd = await sumBalancesToUsd(
        wallets.map((w: any) => ({
          currency: w.currency,
          balance: Number(w.balance ?? 0),
        }))
      );

      let providerSnapshot: unknown = null;
      if (this.greyService.isConfigured()) {
        try {
          providerSnapshot = await this.greyService.fetchProviderAccounts();
        } catch {
          /* KYB pending or path mismatch — stored rows still returned */
        }
      }

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Grey accounts'),
        enums.HTTP_OK,
        {
          provider: 'grey',
          totalAvailableBalance: {
            currency: PRIMARY_CURRENCY,
            amount: totalUsd,
            formatted: formatPrdWalletDetails(wallets as any, totalUsd)
              .totalAvailableBalance.formatted,
          },
          operatingAccounts: accounts,
          accounts,
          providerSnapshot,
          inflowPolicy: {
            USD: 'Credits USD wallet',
            EUR: 'Credits EUR wallet',
            GBP: 'Credits GBP wallet',
            NGN: 'Credits NGN wallet (Flutterwave)',
          },
        }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  /** PRD: POST /wallets/add/fiat/ngn — Flutterwave VA on NGN wallet */
  provisionNgnFiatAccount = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      if (!user?.user_id) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }
      const profile = await db.oneOrNone<{ email: string; bvn: string | null }>(
        `SELECT email, bvn FROM users WHERE user_id = $1 LIMIT 1`,
        [user.user_id]
      );
      const email = profile?.email ?? user?.email;
      const bvn = String(
        profile?.bvn ?? (user as { bvn?: string })?.bvn ?? req.body?.bvn ?? ''
      ).trim();
      if (!email || !bvn) {
        return errorResponse(
          res,
          'Complete BVN and NIN verification to receive NGN by bank transfer',
          enums.HTTP_BAD_REQUEST
        );
      }
      const wallet = await this.paymentService.ensureNgnVirtualAccount(
        user.user_id,
        email,
        String(bvn)
      );
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('NGN virtual account'),
        enums.HTTP_OK,
        {
          currency: 'NGN',
          accountNumber: (wallet as any).account_number,
          bankName: (wallet as any).bank_name,
          provider: 'flutterwave',
        }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  /** Flutterwave collection webhook → credit NGN wallet */
  flutterwaveWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const body = req.body as Record<string, unknown>;
      const data =
        body.data && typeof body.data === 'object'
          ? (body.data as Record<string, unknown>)
          : body;
      const amount = Number(data.amount ?? body.amount);
      const reference = String(
        data.tx_ref ?? data.flw_ref ?? data.id ?? body.tx_ref ?? ''
      );
      const email = String(data.email ?? body.email ?? '');
      if (!reference || !Number.isFinite(amount) || amount <= 0) {
        return errorResponse(res, 'Invalid webhook payload', enums.HTTP_BAD_REQUEST);
      }

      const wallet = await db.oneOrNone<{ user_id: string }>(
        `SELECT w.user_id FROM wallets w
         JOIN users u ON u.user_id = w.user_id
         WHERE w.currency = 'NGN' AND (u.email = $1 OR w.account_number = $2)
         LIMIT 1`,
        [email, String(data.account_number ?? '')]
      );
      if (!wallet?.user_id) {
        return errorResponse(res, 'User not found for deposit', enums.HTTP_NOT_FOUND);
      }

      const result = await this.paymentService.creditWalletInflow(
        wallet.user_id,
        amount,
        'NGN',
        'NGN',
        'flutterwave',
        reference
      );

      return res.status(200).json({ received: true, duplicate: result.duplicate });
    } catch (err: any) {
      console.error('Flutterwave webhook error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };

  /** Receive flow: USDC/EURC on Stellar + Ethereum (auto-provisions if missing). */
  getCryptoBalances = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const walletsByCurrency = await this.paymentService.ensureUserLedgerWallets(
        userId
      );
      await provisionCryptoWalletsForUser(userId);

      try {
        await syncStellarInflowsToLedger({
          userId,
          walletsByCurrency,
        });
      } catch (syncErr: unknown) {
        console.warn(
          `[getCryptoBalances] stellar sync skipped for user=${userId}: ${
            syncErr instanceof Error ? syncErr.message : String(syncErr)
          }`
        );
      }

      const balances = await getCryptoBalances(userId);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Crypto balances'),
        enums.HTTP_OK,
        balances
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  syncCryptoInflows = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const walletsByCurrency = await this.paymentService.ensureUserLedgerWallets(
        userId
      );
      await provisionCryptoWalletsForUser(userId);

      const sync = await syncStellarInflowsToLedger({
        userId,
        walletsByCurrency,
      });
      const wallets = await this.paymentService.getWalletsByUserId(userId);
      const totalUsd = await sumBalancesToUsd(
        wallets.map((w: any) => ({
          currency: w.currency,
          balance: Number(w.balance ?? 0),
        }))
      );

      return success(
        res,
        'Crypto inflows synced',
        enums.HTTP_OK,
        {
          sync,
          walletDetails: formatPrdWalletDetails(wallets as any, totalUsd),
        }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getCryptoSendConfig = async (_req: Request, res: Response): Promise<any> => {
    return success(
      res,
      enums.FETCHED_SUCCESSFULLY('Crypto send config'),
      enums.HTTP_OK,
      getCryptoSendConfig()
    );
  };

  sendCrypto = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const { to, amount, asset, network, memo } = req.body;

      await provisionCryptoWalletsForUser(userId);

      const result = await routeCryptoSend({
        userId,
        to: String(to),
        amount: String(amount),
        asset: String(asset),
        network: String(network),
        memo: memo ? String(memo) : undefined,
      });

      const ledger = await recordCryptoOutboundLedger({
        userId,
        amount: String(amount),
        asset: String(asset),
        network: String(network),
        txHash: result.hash,
        to: result.to,
        from: result.from,
      });

      return success(
        res,
        'Crypto transfer submitted',
        enums.HTTP_OK,
        { ...result, ledger }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  getReceiveCrypto = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      const userId = user?.user_id as string;
      const walletsByCurrency = await this.paymentService.ensureUserLedgerWallets(
        userId
      );

      let row = await db.oneOrNone<{
        stellar_deposit_address: string | null;
        ethereum_deposit_address: string | null;
      }>(
        `SELECT stellar_deposit_address, ethereum_deposit_address
         FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
        [userId]
      );

      if (!row?.stellar_deposit_address || !row?.ethereum_deposit_address) {
        await provisionCryptoWalletsForUser(userId);
        row = await db.oneOrNone<{
          stellar_deposit_address: string | null;
          ethereum_deposit_address: string | null;
        }>(
          `SELECT stellar_deposit_address, ethereum_deposit_address
           FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
          [userId]
        );
      }

      if (!row?.stellar_deposit_address || !row?.ethereum_deposit_address) {
        return errorResponse(
          res,
          'Crypto wallet provisioning failed. Retry in a moment.',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }

      try {
        await syncStellarInflowsToLedger({
          userId,
          walletsByCurrency,
        });
      } catch (syncErr: unknown) {
        console.warn(
          `[getReceiveCrypto] stellar sync skipped for user=${userId}: ${
            syncErr instanceof Error ? syncErr.message : String(syncErr)
          }`
        );
      }

      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Crypto receive details'),
        enums.HTTP_OK,
        buildReceiveCryptoPayload(row)
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getReceiveOptions = async (_req: Request, res: Response): Promise<any> => {
    return success(
      res,
      enums.FETCHED_SUCCESSFULLY('Receive options'),
      enums.HTTP_OK,
      {
        options: [
          { id: 'us_bank', label: 'US Bank Account', path: '/payments/receive/us-bank' },
          { id: 'crypto', label: 'USDC Wallet', path: '/payments/receive/crypto' },
        ],
      }
    );
  };

  getPayoutQuoteHandler = async (req: Request, res: Response): Promise<any> => {
    try {
      const { amountUsd, targetCurrency, feeUsd } = req.query;
      const quote = await getPayoutQuote({
        amountUsd: Number(amountUsd),
        targetCurrency: String(targetCurrency),
        feeUsd: feeUsd != null ? Number(feeUsd) : undefined,
      });
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Payout quote'),
        enums.HTTP_OK,
        quote
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  getInvestment = async (req: Request, res: Response): Promise<any> => {
    try {
      const summary = await getInvestmentSummary(req.user?.user_id);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Investment pocket'),
        enums.HTTP_OK,
        summary
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getInvestmentPlansHandler = async (
    _req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const data = await getInvestmentPlans();
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Investment plans'),
        enums.HTTP_OK,
        data
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getInvestmentPositionsHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const positions = await listInvestmentPositions(req.user?.user_id);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Investment positions'),
        enums.HTTP_OK,
        { positions }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getInvestmentQuoteHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const amount = Number(req.query.amount);
      const lockDays = Number(req.query.lockDays);
      const quote = await quoteInvestment(amount, lockDays);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Investment quote'),
        enums.HTTP_OK,
        quote
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  acceptInvestmentRiskHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      await acceptInvestmentRisk(req.user?.user_id);
      return success(
        res,
        'Risk disclosure accepted',
        enums.HTTP_OK,
        { accepted: true }
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  depositInvestment = async (req: Request, res: Response): Promise<any> => {
    try {
      const { amount, lockDays, name, idempotencyKey } = req.body;
      const usd = await this.paymentService.ensureUsdWallet(req.user?.user_id);
      const result = await depositToInvestment({
        userId: req.user?.user_id,
        usdWalletId: usd.wallet_id,
        amount: Number(amount),
        lockDays: Number(lockDays),
        name: String(name || '').trim(),
        idempotencyKey,
      });
      return success(
        res,
        'Funds invested successfully',
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  claimInvestmentPositionHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const { idempotencyKey } = req.body;
      const positionId = String(req.params.positionId || '');
      const usd = await this.paymentService.ensureUsdWallet(req.user?.user_id);
      const result = await claimInvestmentPosition({
        userId: req.user?.user_id,
        usdWalletId: usd.wallet_id,
        positionId,
        idempotencyKey,
      });
      return success(
        res,
        'Investment claimed successfully',
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  withdrawInvestment = async (req: Request, res: Response): Promise<any> => {
    try {
      const { amount, idempotencyKey } = req.body;
      const usd = await this.paymentService.ensureUsdWallet(req.user?.user_id);
      const result = await withdrawFromInvestment({
        userId: req.user?.user_id,
        usdWalletId: usd.wallet_id,
        amount: Number(amount),
        idempotencyKey,
      });
      return success(
        res,
        'Withdrawal successful',
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  getDayEarn = async (req: Request, res: Response): Promise<any> => {
    try {
      const summary = await getDayEarnSummary(req.user?.user_id);
      return success(res, 'DayEarn summary', enums.HTTP_OK, summary);
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  getDayEarnPreview = async (req: Request, res: Response): Promise<any> => {
    try {
      const amount = Number(req.query.amount);
      const currency = String(req.query.currency);
      const preview = computeInterestPreview(amount, currency);
      return success(res, 'DayEarn preview', enums.HTTP_OK, preview);
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  getDayEarnPot = async (req: Request, res: Response): Promise<any> => {
    try {
      const potId = String(req.params.potId || '');
      const detail = await getDayEarnPotDetail(req.user?.user_id, potId);
      return success(res, 'DayEarn pot', enums.HTTP_OK, detail);
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  createDayEarnPotHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const { name, amount, currency, idempotencyKey } = req.body;
      const wallet = await this.paymentService.ensureWalletForCurrency(
        req.user?.user_id,
        currency
      );
      const result = await createDayEarnPot({
        userId: req.user?.user_id,
        walletId: wallet.wallet_id,
        name: String(name),
        amount: Number(amount),
        currency: String(currency),
        idempotencyKey,
      });
      return success(
        res,
        'DayEarn pot created successfully',
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  depositDayEarnPotHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const { amount, idempotencyKey } = req.body;
      const potId = String(req.params.potId || '');
      const detail = await getDayEarnPotDetail(req.user?.user_id, potId);
      const currency = detail.pot.currency;
      const wallet = await this.paymentService.ensureWalletForCurrency(
        req.user?.user_id,
        currency
      );
      const result = await depositToDayEarnPot({
        userId: req.user?.user_id,
        walletId: wallet.wallet_id,
        potId,
        amount: Number(amount),
        idempotencyKey,
      });
      return success(
        res,
        'Added to DayEarn successfully',
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  withdrawDayEarnPotHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const { amount, withdrawAll, idempotencyKey } = req.body;
      const potId = String(req.params.potId || '');
      const detail = await getDayEarnPotDetail(req.user?.user_id, potId);
      const currency = detail.pot.currency;
      const wallet = await this.paymentService.ensureWalletForCurrency(
        req.user?.user_id,
        currency
      );
      const result = await withdrawFromDayEarnPot({
        userId: req.user?.user_id,
        walletId: wallet.wallet_id,
        potId,
        amount: amount != null ? Number(amount) : undefined,
        withdrawAll: withdrawAll === true,
        idempotencyKey,
      });
      return success(
        res,
        'Withdrawal successful',
        enums.HTTP_OK,
        result
      );
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  renameDayEarnPotHandler = async (
    req: Request,
    res: Response
  ): Promise<any> => {
    try {
      const potId = String(req.params.potId || '');
      const { name } = req.body;
      const result = await renameDayEarnPot(
        req.user?.user_id,
        potId,
        String(name)
      );
      return success(res, 'DayEarn pot renamed', enums.HTTP_OK, result);
    } catch (err: any) {
      return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
    }
  };

  greyWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const signature = (req.headers['x-grey-signature'] ??
        req.headers['x-webhook-signature']) as string | undefined;
      const raw = JSON.stringify(req.body);
      if (
        this.greyService.isConfigured() &&
        !this.greyService.verifyWebhookSignature(raw, signature)
      ) {
        return errorResponse(res, 'Invalid webhook signature', enums.HTTP_UNAUTHORIZED);
      }

      const parsed = this.greyService.parseCollectionWebhook(
        req.body as Record<string, unknown>
      );
      if (!parsed) {
        return errorResponse(res, 'Invalid webhook payload', enums.HTTP_BAD_REQUEST);
      }

      const target = String(parsed.currency).toUpperCase();
      const result = await this.paymentService.creditWalletInflow(
        parsed.userId,
        parsed.amount,
        parsed.currency,
        target,
        'grey',
        parsed.reference
      );

      return res.status(200).json({ received: true, duplicate: result.duplicate });
    } catch (err: any) {
      console.error('Grey webhook error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };

  /** @deprecated Use POST /payments/grey/webhook */
  fincraWebhook = async (req: Request, res: Response): Promise<any> =>
    this.greyWebhook(req, res);

  webhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const { event, sequenceId, amount, currency, usdAmount, localAmount } =
        req.body;

      console.log('Incoming Webhook:', req.body);

      switch (event) {
        case 'COLLECTION.COMPLETE':
          await this.paymentService.completeCollectionInflow(sequenceId, {
            amount: Number(amount ?? localAmount),
            currency: currency as string | undefined,
            usdAmount: usdAmount != null ? Number(usdAmount) : undefined,
          });
          break;

        case 'COLLECTION.FAILED':
          await this.paymentService.updateTransactionStatus(
            sequenceId,
            'failed-collection'
          );
          break;

        case 'PAYMENT.COMPLETE':
          await this.paymentService.updateTransactionPaymentStatus(
            sequenceId,
            'success-payment'
          );
          break;

        case 'PAYMENT.FAILED':
          await this.paymentService.updateTransactionPaymentStatus(
            sequenceId,
            'failed-payment'
          );
          break;

        default:
          console.warn(`Unhandled webhook event: ${event}`);
      }

      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error('Webhook processing error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };
}

export const paymentController = new PaymentController();
