import express from 'express';
import { paymentController } from './controller';
import { billsController } from './billsController';
import { budgetController } from './budgetController';
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

Router.get(
  '/banks/ng',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.fetchNigerianBanks
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
  '/wallet/recovery-phrase',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.walletRecoveryPhrase,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentController.getWalletRecoveryPhrase
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
  '/feature-activity',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getFeatureActivity
);

Router.get(
  '/beneficiaries',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.fetchBeneficiaries,
  paymentController.getUserBeneficiaries
);

Router.post(
  '/beneficiaries',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.saveBeneficiary,
  paymentController.saveBeneficiary
);

Router.post(
  '/wallets',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.createWallet,
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

Router.get(
  '/exchange-rates/wallet',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getWalletExchangeRates
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
  '/budgets',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.list
);

Router.post(
  '/budgets',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.create
);

Router.get(
  '/budgets/:budgetId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.getOne
);

Router.patch(
  '/budgets/:budgetId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.update
);

Router.post(
  '/budgets/:budgetId/pause',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.pause
);

Router.post(
  '/budgets/:budgetId/resume',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.resume
);

Router.delete(
  '/budgets/:budgetId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  budgetController.remove
);

Router.get(
  '/investment',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getInvestment
);

Router.get(
  '/investment/plans',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getInvestmentPlansHandler
);

Router.get(
  '/investment/positions',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getInvestmentPositionsHandler
);

Router.get(
  '/investment/quote',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.getInvestmentQuote,
  paymentController.getInvestmentQuoteHandler
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

Router.post(
  '/investment/positions/:positionId/claim',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.investmentClaim,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.claimInvestmentPositionHandler
);

Router.get(
  '/dayearn',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getDayEarn
);

Router.get(
  '/dayearn/preview',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.dayEarnPreview,
  paymentController.getDayEarnPreview
);

Router.get(
  '/dayearn/pots/:potId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentController.getDayEarnPot
);

Router.post(
  '/dayearn/pots',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.dayEarnCreatePot,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.createDayEarnPotHandler
);

Router.post(
  '/dayearn/pots/:potId/deposit',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.dayEarnDeposit,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.depositDayEarnPotHandler
);

Router.post(
  '/dayearn/pots/:potId/withdraw',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.dayEarnWithdraw,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentController.withdrawDayEarnPotHandler
);

Router.patch(
  '/dayearn/pots/:potId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.dayEarnRename,
  paymentController.renameDayEarnPotHandler
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

Router.get(
  '/bills/categories',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  billsController.getCategories
);

Router.get(
  '/bills/categories/:category/billers',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  billsController.getBillers
);

Router.get(
  '/bills/billers/:billerCode/items',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  billsController.getItems
);

Router.post(
  '/bills/validate',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.validateBill,
  billsController.validateBill
);

Router.post(
  '/bills/pay',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  paymentValidator.payBill,
  paymentMiddleware.validatePasswordOrPin('pin'),
  paymentMiddleware.withSpendCurrency('NGN'),
  paymentMiddleware.checkWalletExistsByUserId,
  paymentMiddleware.checkSufficientBalance,
  billsController.payBill
);

Router.get(
  '/bills/status/:reference',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  billsController.getStatus
);

export const paymentRouter = Router;
