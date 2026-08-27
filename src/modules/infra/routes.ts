import express from 'express';
import { infraAuthMiddleware, requireOrgMiddleware, requireVerifiedForLiveMiddleware } from './infraService';
import {
  operatorAuthMiddleware,
  requireOperatorRoles,
} from './infraAdminService';
import {
  adminOperatorLogin,
  adminOperatorMe,
  adminInviteCodesList,
  adminInviteCodesCreate,
  adminInviteCodesRevoke,
  adminAuditList,
  adminOrganizationsList,
  adminOrganizationGet,
  adminOrganizationMembers,
  adminTransactionsList,
  adminTransactionGet,
  adminWalletsList,
  adminWalletGet,
  adminCollectionsList,
  adminCollectionGet,
  adminPayoutsList,
  adminPayoutGet,
  INVITE_WRITE_ROLES,
  ORG_READ_ROLES,
  TX_READ_ROLES,
  WALLET_READ_ROLES,
  COLLECTION_READ_ROLES,
  PAYOUT_READ_ROLES,
} from './adminController';
import {
  verifyEarlyAccess,
  login,
  me,
  overview,
  transactions,
  payments,
  payouts,
  settlements,
  reconciliation,
  reconciliationForTransaction,
  reconciliationItemsList,
  reconciliationRunGet,
  reconciliationRunsList,
  reconciliationRun,
  apiKeysList,
  apiKeysCreate,
  apiKeysRotate,
  apiKeysAudit,
  emailCheck,
  emailStart,
  emailVerifyOtp,
  googleSignIn,
  organizationCreate,
  banksList,
  channelsList,
  corridorsList,
  cryptoNetworksList,
  bankResolve,
  paymentCreate,
  payoutCreate,
  signup,
  forgotPasswordHandler,
  resetPasswordHandler,
  transactionSimulate,
  personalOnboardingComplete,
  dayfiTagSet,
  dayfiTagLookup,
  balance,
  yellowCardWebhook,
  recipientsList,
  recipientsCreate,
  recipientsGet,
  recipientsUpdate,
  recipientsArchive,
  destinationsCreate,
  destinationsArchive,
  bulkList,
  bulkCreate,
  bulkImportCsv,
  bulkGet,
  bulkPreflight,
  bulkConfirm,
  bulkCancel,
  bulkRefresh,
  settlementGet,
  payoutSettleStellar,
  payoutSettleOfframp,
  payoutRetryOfframpProvider,
  settlementConfirm,
  stellarWalletGet,
  stellarWalletProvision,
  stellarFeePayerGet,
  transferCreate,
  transferGet,
  treasuryGet,
  treasuryReconcile,
  treasuryRebalancesList,
  treasuryRebalanceGet,
  treasuryRebalanceCreate,
  treasuryRebalanceApprove,
  treasuryRebalanceSubmit,
} from './controller';

const infraRouter = express.Router();

/** Phase 2 provider webhooks — before auth middleware. */
infraRouter.post('/webhooks/yellowcard', yellowCardWebhook);

infraRouter.post('/auth/early-access/verify', verifyEarlyAccess);
infraRouter.post('/auth/login', login);
infraRouter.post('/auth/signup', signup);
infraRouter.post('/auth/email/check', emailCheck);
infraRouter.post('/auth/email/start', emailStart);
infraRouter.post('/auth/email/verify-otp', emailVerifyOtp);
infraRouter.post('/auth/forgot-password', forgotPasswordHandler);
infraRouter.post('/auth/reset-password', resetPasswordHandler);
infraRouter.post('/auth/google', googleSignIn);

/** Dayfi Back Office — operator auth (not merchant JWT). */
infraRouter.post('/admin/auth/login', adminOperatorLogin);

const adminRouter = express.Router();
adminRouter.use(operatorAuthMiddleware);
adminRouter.get('/auth/me', adminOperatorMe);
adminRouter.get('/invite-codes', adminInviteCodesList);
adminRouter.post(
  '/invite-codes',
  requireOperatorRoles(INVITE_WRITE_ROLES),
  adminInviteCodesCreate
);
adminRouter.patch(
  '/invite-codes/:id/revoke',
  requireOperatorRoles(INVITE_WRITE_ROLES),
  adminInviteCodesRevoke
);
adminRouter.get(
  '/audit',
  requireOperatorRoles(['ops', 'treasury', 'admin', 'support', 'viewer']),
  adminAuditList
);
adminRouter.get(
  '/organizations',
  requireOperatorRoles(ORG_READ_ROLES),
  adminOrganizationsList
);
adminRouter.get(
  '/organizations/:id',
  requireOperatorRoles(ORG_READ_ROLES),
  adminOrganizationGet
);
adminRouter.get(
  '/organizations/:id/members',
  requireOperatorRoles(ORG_READ_ROLES),
  adminOrganizationMembers
);
adminRouter.get(
  '/transactions',
  requireOperatorRoles(TX_READ_ROLES),
  adminTransactionsList
);
adminRouter.get(
  '/transactions/:id',
  requireOperatorRoles(TX_READ_ROLES),
  adminTransactionGet
);
adminRouter.get(
  '/wallets',
  requireOperatorRoles(WALLET_READ_ROLES),
  adminWalletsList
);
adminRouter.get(
  '/wallets/:id',
  requireOperatorRoles(WALLET_READ_ROLES),
  adminWalletGet
);
adminRouter.get(
  '/collections',
  requireOperatorRoles(COLLECTION_READ_ROLES),
  adminCollectionsList
);
adminRouter.get(
  '/collections/:id',
  requireOperatorRoles(COLLECTION_READ_ROLES),
  adminCollectionGet
);
adminRouter.get(
  '/payouts',
  requireOperatorRoles(PAYOUT_READ_ROLES),
  adminPayoutsList
);
adminRouter.get(
  '/payouts/:id',
  requireOperatorRoles(PAYOUT_READ_ROLES),
  adminPayoutGet
);
infraRouter.use('/admin', adminRouter);

infraRouter.use(infraAuthMiddleware);

infraRouter.get('/auth/me', me);
infraRouter.post('/organizations', organizationCreate);
infraRouter.post('/onboarding/personal', personalOnboardingComplete);
infraRouter.post('/profile/dayfi-tag', dayfiTagSet);
infraRouter.get('/reference/dayfi-tag/:tag', dayfiTagLookup);

infraRouter.use(requireOrgMiddleware);
infraRouter.use(requireVerifiedForLiveMiddleware);

infraRouter.get('/overview', overview);
infraRouter.get('/balance', balance);
/** Increment B — org Stellar custody wallet (public key only; no secrets). */
infraRouter.get('/wallet/stellar', stellarWalletGet);
infraRouter.post('/wallet/stellar/provision', stellarWalletProvision);
infraRouter.get('/wallet/stellar/fee-payer', stellarFeePayerGet);
infraRouter.get('/transactions', transactions);
infraRouter.post('/transactions/:id/simulate', transactionSimulate);
infraRouter.get('/payments', payments);
infraRouter.post('/payments', paymentCreate);
infraRouter.get('/payouts', payouts);
infraRouter.post('/payouts', payoutCreate);
/** Phase 5 — settle locked crypto payout via Stellar USDC */
infraRouter.post('/payouts/:id/settle-stellar', payoutSettleStellar);
/** Increment H — Alice USDC → treasury → Provider bank payout */
infraRouter.post('/payouts/:id/settle-offramp', payoutSettleOfframp);
infraRouter.post('/payouts/:id/retry-provider', payoutRetryOfframpProvider);

/** Increment E — Dayfi-to-Dayfi ledger transfer (no Stellar). */
infraRouter.post('/transfers', transferCreate);
infraRouter.get('/transfers/:id', transferGet);

/** Phase 3 — Recipients (org-scoped; destinations are rail payloads). */
infraRouter.get('/recipients', recipientsList);
infraRouter.post('/recipients', recipientsCreate);
infraRouter.get('/recipients/:id', recipientsGet);
infraRouter.patch('/recipients/:id', recipientsUpdate);
infraRouter.delete('/recipients/:id', recipientsArchive);
infraRouter.post('/recipients/:id/destinations', destinationsCreate);
infraRouter.delete('/recipients/:id/destinations/:destinationId', destinationsArchive);

/** Phase 4 — Bulk (parent orchestrates; Phase 2 child payouts move money). */
infraRouter.get('/bulk', bulkList);
infraRouter.post('/bulk', bulkCreate);
infraRouter.post('/bulk/import-csv', bulkImportCsv);
infraRouter.get('/bulk/:id', bulkGet);
infraRouter.post('/bulk/:id/preflight', bulkPreflight);
infraRouter.post('/bulk/:id/confirm', bulkConfirm);
infraRouter.post('/bulk/:id/cancel', bulkCancel);
infraRouter.post('/bulk/:id/refresh', bulkRefresh);

infraRouter.get('/settlements', settlements);
infraRouter.get('/settlements/:id', settlementGet);
infraRouter.post('/settlements/:id/confirm', settlementConfirm);
infraRouter.get('/reconciliation', reconciliation);
infraRouter.post('/reconciliation/runs', reconciliationRun);
infraRouter.get('/reconciliation/runs', reconciliationRunsList);
infraRouter.get('/reconciliation/runs/:id', reconciliationRunGet);
infraRouter.get('/reconciliation/items', reconciliationItemsList);
infraRouter.get('/reconciliation/transactions/:transactionId', reconciliationForTransaction);

/** Increment G — treasury liquidity observation + manual rebalance (no auto bot). */
infraRouter.get('/treasury', treasuryGet);
infraRouter.post('/treasury/reconcile', treasuryReconcile);
infraRouter.get('/treasury/rebalances', treasuryRebalancesList);
infraRouter.post('/treasury/rebalances', treasuryRebalanceCreate);
infraRouter.get('/treasury/rebalances/:id', treasuryRebalanceGet);
infraRouter.post('/treasury/rebalances/:id/approve', treasuryRebalanceApprove);
infraRouter.post('/treasury/rebalances/:id/submit', treasuryRebalanceSubmit);

infraRouter.get('/reference/banks', banksList);
infraRouter.get('/reference/channels', channelsList);
infraRouter.get('/reference/corridors', corridorsList);
infraRouter.get('/reference/crypto-networks', cryptoNetworksList);
infraRouter.post('/reference/resolve-bank', bankResolve);

infraRouter.get('/developers/api-keys', apiKeysList);
infraRouter.post('/developers/api-keys', apiKeysCreate);
infraRouter.get('/developers/api-keys/audit', apiKeysAudit);
infraRouter.post('/developers/api-keys/:id/rotate', apiKeysRotate);

export { infraRouter };
