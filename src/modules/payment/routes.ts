import express from 'express';
import { paymentController } from './controller';
import { paymentValidator } from './validator';
import { authMiddleware } from '../authentication/middleware';
import { paymentMiddleware } from './middleware';

const Router = express.Router();

Router.post(
  '/resolve-account',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.resolveBankAccount,
  paymentController.resolveBankAccount
);

Router.post(
  '/initiate-wallet-transfer',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.transferToVirtualAccount,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExists,
  paymentMiddleware.checkWalletExistsByUserId,
  paymentMiddleware.checkSufficientBalance,
  paymentController.transferToVirtualAccount
);

Router.get(
  '/banks',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchBanks
);

Router.post(
  '/add-dayfi-id',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.addDayfiId,
  // No checkWalletExistsByUserId: handler ensures a primary wallet exists before updating dayfi_id.
  paymentController.addDayfiId
);

Router.get(
  '/validate-dayfi-id/:dayfiId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchDayfiId
);

Router.post(
  '/charge-card',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.chargeUserCard,
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.chargeUserCard
);

Router.post(
  '/verify-charge',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.verifyCardCharge,
  paymentController.verifyCardCharge
);

Router.post(
  '/verify-payment',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.verifyPayment,
  paymentController.verifyPayment
);

Router.post(
  '/charge-card-with-token',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.chargeUserWithToken,
  paymentController.chargeUserWithToken
);

Router.get(
  '/wallet-details',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getWalletDetails
);

Router.get(
  '/wallets/balances',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getWalletBalances
);

Router.get(
  '/fees',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchFees
);

Router.post(
  '/wallet-provision/start',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.startWalletProvision
);

Router.get(
  '/wallet-provision/status/:jobId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getWalletProvisionStatus
);

Router.post(
  '/bank-transfer',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.bankTransfer,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentMiddleware.checkSufficientBalance,
  paymentController.bankTransfer
);

Router.get(
  '/wallet-transactions',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.fetchWalletTransactions,
  paymentController.fetchWalletTransactions
);

Router.get(
  '/beneficiaries',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.fetchBeneficiaries,
  paymentController.getUserBeneficiaries
);

Router.post(
  '/wallets',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.createWallet,
  paymentMiddleware.checkUserWalletExists,
  paymentController.createWallet
);

Router.post(
  '/exchange-rate',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.createExchangeRate,
  paymentController.createExchangeRate
);

Router.get(
  '/exchange-rate',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.getExchangeRate,
  paymentController.getExchangeRate
);

Router.post(
  '/wallets/swap',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.swapCurrency,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentMiddleware.checkSufficientBalance,
  paymentController.swapCurrency
);

Router.post(
  '/wallets/add/fiat/ngn',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.provisionNgnFiatAccount
);

Router.post('/webhooks/flutterwave', paymentController.flutterwaveWebhook);

Router.post('/webhook', paymentController.processWebhookData);

Router.get(
  '/capabilities',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getPaymentCapabilities
);

Router.get(
  '/receive/options',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getReceiveOptions
);

Router.get(
  '/receive/us-bank',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getReceiveUsBank
);

Router.get(
  '/receive/crypto',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getReceiveCrypto
);

Router.get(
  '/crypto/send-config',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getCryptoSendConfig
);

Router.get(
  '/crypto/balances',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getCryptoBalances
);

Router.post(
  '/crypto/sync-inflows',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.syncCryptoInflows
);

Router.post(
  '/crypto/send',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.sendCrypto,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentController.sendCrypto
);

Router.get(
  '/send/quote',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.getPayoutQuote,
  paymentController.getPayoutQuoteHandler
);

Router.get(
  '/investment',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getInvestment
);

Router.post(
  '/investment/accept-risk',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.acceptInvestmentRiskHandler
);

Router.post(
  '/investment/deposit',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.investmentDeposit,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.depositInvestment
);

Router.post(
  '/investment/withdraw',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.investmentWithdraw,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.withdrawInvestment
);

Router.get(
  '/crypto-channels',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchCryptoChannels
);

Router.get(
  '/channels',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchChannels
);

Router.get(
  '/networks',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchNetworks
);

Router.get(
  '/rates',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.fetchExchangeRates,
  paymentController.fetchExchangeRates
);

Router.post(
  '/create-collections',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.createCollectionRequest,
  paymentController.createCollectionRequest
);

Router.post(
  '/create-payment-request',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.createPaymentRequest,
  paymentController.createPaymentRequest
);

Router.post(
  '/resolve-bank',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.resolveBankDetailsYC,
  paymentController.resolveBankDetailsYC
);

Router.post(
  '/yc-webhooks',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.createWebhook,
  paymentController.createWebhook
);

Router.get(
  '/yc-webhooks',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchWebhooks
);

Router.put(
  '/yc-webhooks',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.updateWebhook,
  paymentController.updateWebhook
);

Router.delete(
  '/yc-webhooks/:id',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.removeWebhook
);

Router.post('/yc-webhook', paymentController.webhook);

Router.post('/grey/webhook', paymentController.greyWebhook);

Router.get(
  '/grey/accounts',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getGreyAccounts
);

/** @deprecated — forwards to Grey webhook */
Router.post('/fincra/webhook', paymentController.greyWebhook);

export const paymentRouter = Router;
