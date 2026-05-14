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
  paymentMiddleware.checkWalletExistsByUserId,
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
  paymentController.swapCurrency
);

Router.post('/webhook', paymentController.processWebhookData);

Router.get(
  '/capabilities',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getPaymentCapabilities
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

export const paymentRouter = Router;
