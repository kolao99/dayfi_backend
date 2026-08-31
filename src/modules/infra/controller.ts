import { Request, Response, NextFunction } from 'express';
import {
  checkInviteCode,
  getMemberProfile,
  listApiKeys,
  createApiKey,
  rotateApiKey,
  listKeyAudit,
  getOverview,
  getTransactions,
  checkEmail,
  startEmailAuth,
  verifyEmailOtp,
  googleAuth,
  createOrganization,
  signupWithPassword,
  loginWithPassword,
  forgotPassword,
  resetPassword,
  completePersonalOnboarding,
  setDayfiTag,
  lookupDayfiTag,
  success,
  errorResponse,
} from './infraService';
import { redeemInviteCode, getInviteByCode, deriveInviteStatus } from './infraAdminService';
import {
  listWebhookEndpoints,
  createWebhookEndpoint,
  revokeWebhookEndpoint,
  listWebhookDeliveries,
} from './infraWebhookService';
import {
  createCollection,
  createPayout,
  InfraRailError,
  InfraIdempotencyError,
  listBanks,
  listChannels,
  resolveBank,
  simulateSettlement,
  listCorridors,
  listCryptoNetworks,
} from './infraMoneyService';
import { getOrgBalance, InfraLedgerError } from './infraLedgerService';
import {
  applyInfraYellowCardWebhook,
} from './infraLifecycleService';
import {
  assertYellowCardWebhookAuthenticated,
  YellowCardWebhookAuthError,
} from '../payment/yellowCardWebhook';
import {
  addDestination,
  archiveDestination,
  archiveRecipient,
  createRecipient,
  getRecipient,
  InfraRecipientError,
  listRecipients,
  updateRecipient,
} from './infraRecipientService';
import {
  cancelBulkBatch,
  confirmBulkBatch,
  createBulkBatch,
  getBulkBatch,
  importBulkCsv,
  InfraBulkError,
  listBulkBatches,
  refreshBatchAggregates,
  runPreflight,
} from './infraBulkService';
import {
  confirmStellarSettlement,
  getSettlement,
  InfraSettlementError,
  listSettlements,
  settlePayoutOnStellar,
} from './infraSettlementService';
import {
  InfraFiatWithdrawalError,
  retryFiatOfframpProvider,
  settleFiatOfframp,
} from './infraFiatWithdrawalService';
import {
  getOrgStellarAccount,
  InfraStellarAccountError,
  provisionOrgStellarAccount,
} from './infraStellarAccountService';
import { StellarCustodyError } from './infraStellarCustody';
import {
  createInternalTransfer,
  getInternalTransfer,
  InfraTransferError,
} from './infraInternalTransferService';
import {
  getStellarFeePayerStatus,
  InfraFeePayerError,
} from './infraStellarFeePayerService';
import { InfraFeeError } from './infraFeeService';
import {
  getReconciliationForTransaction,
  getReconciliationOverview,
  getReconciliationRun,
  InfraReconciliationError,
  listReconciliationItems,
  listReconciliationRuns,
  runReconciliation,
} from './infraReconciliationService';
import {
  approveTreasuryRebalance,
  executeTreasuryRebalance,
  getTreasuryPosition,
  getTreasuryRebalance,
  InfraTreasuryError,
  listTreasuryRebalances,
  reconcileTreasuryPosition,
  requestTreasuryRebalance,
  submitTreasuryRebalance,
} from './infraTreasuryService';

export async function verifyEarlyAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const code = String(req.body?.code || '');
    const previewRow = await getInviteByCode(code);
    if (previewRow) {
      const status = deriveInviteStatus(previewRow);
      if (status !== 'ACTIVE') {
        errorResponse(res, `Invite code is ${status.toLowerCase()}`, 400);
        return;
      }
      success(res, 'Invite verified', 200, {
        ok: true,
        code: previewRow.code,
        assigned_email: previewRow.assigned_email,
        assignedEmail: previewRow.assigned_email,
        status,
        environment: previewRow.environment || 'both',
      });
      return;
    }
    const ok = await checkInviteCode(code);
    if (!ok) {
      errorResponse(res, 'Invalid invite code', 400);
      return;
    }
    success(res, 'Invite verified', 200, {
      ok: true,
      code: code.trim().toUpperCase(),
      assigned_email: null,
      assignedEmail: null,
      status: 'ACTIVE',
      environment: 'both',
    });
  } catch (err) {
    next(err);
  }
}

/** Password login — always requires OTP before dashboard session. */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const inviteCode = String(req.body?.invite_code || req.body?.inviteCode || '');

    if (inviteCode) {
      const { assertInviteAssignable } = await import('./infraAdminService');
      await assertInviteAssignable({ code: inviteCode, email });
    }
    const data = await loginWithPassword(email, password);
    if (inviteCode) {
      await redeemInviteCode({ code: inviteCode, email });
    }
    success(res, 'OTP sent. Verify to continue.', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Login failed', 401);
  }
}

export async function emailCheck(req: Request, res: Response): Promise<void> {
  try {
    const data = await checkEmail(String(req.body?.email || ''));
    success(res, 'Email checked', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Invalid email', 400);
  }
}

export async function signup(req: Request, res: Response): Promise<void> {
  try {
    const inviteCode = String(req.body?.invite_code || req.body?.inviteCode || '');
    const email = String(req.body?.email || '');
    if (inviteCode) {
      const { assertInviteAssignable } = await import('./infraAdminService');
      await assertInviteAssignable({ code: inviteCode, email });
    }
    const data = await signupWithPassword({
      email,
      password: String(req.body?.password || ''),
      firstName: String(req.body?.firstName || req.body?.first_name || ''),
      lastName: String(req.body?.lastName || req.body?.last_name || ''),
      accountType: String(req.body?.accountType || req.body?.account_type || 'business'),
    });
    if (inviteCode) {
      await redeemInviteCode({ code: inviteCode, email });
    }
    success(res, 'Account created. Verify OTP to continue.', 201, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Signup failed', 400);
  }
}

export async function emailStart(req: Request, res: Response): Promise<void> {
  try {
    const data = await startEmailAuth(String(req.body?.email || ''));
    success(res, 'OTP sent', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to start authentication', 400);
  }
}

export async function emailVerifyOtp(req: Request, res: Response): Promise<void> {
  try {
    const data = await verifyEmailOtp(
      String(req.body?.email || ''),
      String(req.body?.otp || req.body?.userOtp || ''),
      req.body?.type || req.body?.purpose
    );
    success(res, 'Authenticated', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'OTP verification failed', 400);
  }
}

export async function forgotPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const data = await forgotPassword(String(req.body?.email || ''));
    success(res, 'If an account exists, a reset code was sent.', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to start password reset', 400);
  }
}

export async function resetPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const data = await resetPassword({
      email: String(req.body?.email || ''),
      password: String(req.body?.password || ''),
      resetToken: String(req.body?.resetToken || req.body?.reset_token || ''),
    });
    success(res, 'Password updated. Please log in.', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to reset password', 400);
  }
}

export async function googleSignIn(req: Request, res: Response): Promise<void> {
  try {
    const data = await googleAuth(
      String(req.body?.authToken || req.body?.credential || ''),
      {
        accountType: String(req.body?.accountType || req.body?.account_type || 'business'),
      }
    );
    success(res, 'OTP sent. Verify to continue.', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Google authentication failed', 400);
  }
}

export async function organizationCreate(req: Request, res: Response): Promise<void> {
  try {
    const data = await createOrganization(
      req.infra!.memberId,
      String(req.body?.name || req.body?.legalName || '')
    );
    const tag = String(req.body?.dayfiTag || req.body?.dayfi_tag || '').trim();
    if (tag) {
      try {
        const withTag = await setDayfiTag(req.infra!.memberId, tag);
        success(res, 'Organization created', 201, withTag);
        return;
      } catch {
        /* org created; tag optional */
      }
    }
    success(res, 'Organization created', 201, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to create organization', 400);
  }
}

export async function personalOnboardingComplete(req: Request, res: Response): Promise<void> {
  try {
    const data = await completePersonalOnboarding(req.infra!.memberId, {
      dayfiTag: String(req.body?.dayfiTag || req.body?.username || ''),
      phone: req.body?.phone,
      dateOfBirth: req.body?.dateOfBirth || req.body?.dob,
      country: req.body?.country,
      address: req.body?.address,
      bvn: req.body?.bvn,
    });
    success(res, 'Personal profile completed', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to complete personal onboarding', 400);
  }
}

export async function dayfiTagSet(req: Request, res: Response): Promise<void> {
  try {
    const data = await setDayfiTag(
      req.infra!.memberId,
      String(req.body?.dayfiTag || req.body?.username || '')
    );
    success(res, 'Dayfi tag updated', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to set Dayfi tag', 400);
  }
}

export async function dayfiTagLookup(req: Request, res: Response): Promise<void> {
  try {
    const data = await lookupDayfiTag(
      String(req.params.tag || req.query.tag || req.body?.dayfiTag || '')
    );
    success(res, 'Dayfi tag found', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Dayfi tag not found', 404);
  }
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const profile = await getMemberProfile(req.infra!.memberId);
    if (!profile) {
      errorResponse(res, 'Member not found', 404);
      return;
    }
    success(res, 'Profile', 200, profile);
  } catch (err) {
    next(err);
  }
}

export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getOverview(req.infra!.orgId!, req.infraEnv || 'test');
    success(res, 'Overview', 200, data);
  } catch (err) {
    next(err);
  }
}

/** Phase 1: org wallet balance (available / pending / locked). */
export async function balance(req: Request, res: Response): Promise<void> {
  try {
    const asset = req.query.asset ? String(req.query.asset) : 'USDC';
    const data = await getOrgBalance(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      asset
    );
    success(res, 'Balance', 200, data);
  } catch (err: any) {
    if (err instanceof InfraLedgerError) {
      errorResponse(res, err.message, err.status);
      return;
    }
    errorResponse(res, err?.message || 'Unable to load balance', 500);
  }
}

/**
 * Increment B — org Stellar wallet public metadata (no secrets).
 * Ledger balance remains GET /balance; this is on-chain custody identity.
 */
export async function stellarWalletGet(req: Request, res: Response): Promise<void> {
  try {
    const data = await getOrgStellarAccount(
      req.infra!.orgId!,
      req.infraEnv || 'test'
    );
    if (!data) {
      errorResponse(res, 'Stellar wallet not provisioned', 404);
      return;
    }
    success(res, 'Stellar wallet', 200, data);
  } catch (err: any) {
    errorResponse(res, err?.message || 'Unable to load Stellar wallet', 500);
  }
}

/** Increment B — idempotent TESTNET (or mock) Stellar wallet provisioning. */
export async function stellarWalletProvision(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await provisionOrgStellarAccount({
      orgId: req.infra!.orgId!,
      environment: req.infraEnv || 'test',
    });
    success(res, 'Stellar wallet provisioned', 200, data);
  } catch (err: any) {
    if (
      err instanceof InfraStellarAccountError ||
      err instanceof StellarCustodyError
    ) {
      errorResponse(res, err.message, err.status);
      return;
    }
    errorResponse(res, err?.message || 'Unable to provision Stellar wallet', 500);
  }
}

/** Dayfi XLM fee-paying account — public observation only, never a secret. */
export async function stellarFeePayerGet(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await getStellarFeePayerStatus();
    success(res, 'Stellar fee-paying account', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraFeePayerError ? err.status : 500;
    errorResponse(res, err?.message || 'Unable to load fee-paying account', code);
  }
}

export async function transactions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const direction = req.query.direction ? String(req.query.direction) : undefined;
    const data = await getTransactions(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      direction
    );
    success(res, 'Transactions', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function payments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getTransactions(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      'payment'
    );
    success(res, 'Payments', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function payouts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getTransactions(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      'payout'
    );
    success(res, 'Payouts', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function settlements(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Phase 5: real settlement records (rail-agnostic; Stellar first).
    const data = await listSettlements(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      { limit: req.query.limit ? Number(req.query.limit) : undefined }
    );
    success(res, 'Settlements', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function settlementGet(req: Request, res: Response): Promise<void> {
  try {
    const data = await getSettlement(
      req.infra!.orgId!,
      String(req.params.id || '')
    );
    success(res, 'Settlement', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraSettlementError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to get settlement', code);
  }
}

/** Phase 5 — locked crypto payout → Stellar USDC settlement → finalize ledger. */
export async function payoutSettleStellar(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await settlePayoutOnStellar({
      orgId: req.infra!.orgId!,
      payoutTransactionId: String(req.params.id || ''),
    });
    success(res, 'Payout settled on Stellar', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraSettlementError
        ? err.status
        : err instanceof InfraLedgerError
          ? err.status
          : 400;
    errorResponse(res, err.message || 'Unable to settle payout on Stellar', code);
  }
}

/** Increment H — lock already done; Alice→treasury Stellar then Provider payout. */
export async function payoutSettleOfframp(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await settleFiatOfframp({
      orgId: req.infra!.orgId!,
      payoutTransactionId: String(req.params.id || ''),
    });
    const msg =
      data.status === 'provider_retry_required'
        ? 'Offramp Stellar confirmed; Provider failed — retry required'
        : 'Fiat offramp settled';
    success(res, msg, 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraFiatWithdrawalError
        ? err.status
        : err instanceof InfraSettlementError
          ? err.status
          : err instanceof InfraLedgerError
            ? err.status
            : 400;
    errorResponse(res, err.message || 'Unable to settle fiat offramp', code);
  }
}

/** Increment H — idempotent Provider retry after treasury receipt. */
export async function payoutRetryOfframpProvider(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await retryFiatOfframpProvider({
      orgId: req.infra!.orgId!,
      payoutTransactionId: String(req.params.id || ''),
    });
    success(res, 'Provider retry processed', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraFiatWithdrawalError
        ? err.status
        : err instanceof InfraLedgerError
          ? err.status
          : 400;
    errorResponse(res, err.message || 'Unable to retry Provider payout', code);
  }
}

export async function settlementConfirm(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await confirmStellarSettlement(
      req.infra!.orgId!,
      String(req.params.id || '')
    );
    success(res, 'Settlement confirmed', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraSettlementError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to confirm settlement', code);
  }
}

export async function reconciliation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await getReconciliationOverview(
      req.infra!.orgId!,
      req.infraEnv || 'test'
    );
    success(res, 'Reconciliation', 200, data);
  } catch (err) {
    next(err);
  }
}

/** Phase 6 — run an observe-only reconciliation pass. */
export async function reconciliationRun(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await runReconciliation({
      orgId: req.infra!.orgId!,
      environment: req.infraEnv || 'test',
      direction:
        req.body?.direction === 'payment' || req.body?.direction === 'payout'
          ? req.body.direction
          : undefined,
      transactionIds: Array.isArray(req.body?.transactionIds)
        ? req.body.transactionIds.map(String)
        : undefined,
      idempotencyKey: req.body?.idempotencyKey
        ? String(req.body.idempotencyKey)
        : undefined,
      triggerSource: 'api',
    });
    success(res, 'Reconciliation run', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraReconciliationError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to run reconciliation', code);
  }
}

export async function reconciliationRunsList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await listReconciliationRuns(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      { limit: req.query.limit ? Number(req.query.limit) : undefined }
    );
    success(res, 'Reconciliation runs', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraReconciliationError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to list reconciliation runs', code);
  }
}

export async function reconciliationRunGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await getReconciliationRun(
      req.infra!.orgId!,
      String(req.params.id || '')
    );
    success(res, 'Reconciliation run', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraReconciliationError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to get reconciliation run', code);
  }
}

export async function reconciliationItemsList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await listReconciliationItems(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        resultCode: req.query.resultCode
          ? String(req.query.resultCode)
          : undefined,
      }
    );
    success(res, 'Reconciliation items', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraReconciliationError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to list reconciliation items', code);
  }
}

export async function reconciliationForTransaction(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await getReconciliationForTransaction(
      req.infra!.orgId!,
      String(req.params.transactionId || '')
    );
    success(res, 'Transaction reconciliation', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraReconciliationError ? err.status : 400;
    errorResponse(
      res,
      err.message || 'Unable to get transaction reconciliation',
      code
    );
  }
}

export async function apiKeysList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listApiKeys(req.infra!.orgId!, req.infraEnv || 'test');
    success(res, 'API keys', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function apiKeysCreate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const name = String(req.body?.name || 'API key').trim();
    const data = await createApiKey(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      name,
      req.infra!
    );
    success(res, 'API key created', 201, data);
  } catch (err) {
    next(err);
  }
}

export async function apiKeysRotate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await rotateApiKey(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      req.params.id,
      req.infra!
    );
    if (!data) {
      errorResponse(res, 'Key not found', 404);
      return;
    }
    success(res, 'API key rotated', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function apiKeysAudit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listKeyAudit(req.infra!.orgId!);
    success(res, 'API key audit', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function webhookEndpointsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const items = await listWebhookEndpoints(req.infra!.orgId!, req.infraEnv || 'test');
    success(res, 'Webhook endpoints', 200, { items });
  } catch (err) {
    next(err);
  }
}

export async function webhookEndpointsCreate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const item = await createWebhookEndpoint(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      {
        label: req.body?.label,
        url: req.body?.url,
        events: req.body?.events,
      },
      req.infra!
    );
    success(res, 'Webhook endpoint created', 201, { item });
  } catch (err: any) {
    if (err?.status) {
      errorResponse(res, err.message || 'Unable to create webhook endpoint', err.status);
      return;
    }
    next(err);
  }
}

export async function webhookEndpointsRevoke(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const ok = await revokeWebhookEndpoint(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      String(req.params.id)
    );
    if (!ok) {
      errorResponse(res, 'Webhook endpoint not found', 404);
      return;
    }
    success(res, 'Webhook endpoint removed', 200, { ok: true });
  } catch (err) {
    next(err);
  }
}

export async function webhookDeliveriesList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const items = await listWebhookDeliveries(req.infra!.orgId!, req.infraEnv || 'test');
    success(res, 'Webhook deliveries', 200, { items });
  } catch (err) {
    next(err);
  }
}

export async function banksList(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await listBanks();
    success(res, 'Banks', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to list banks', 400);
  }
}

export async function channelsList(_req: Request, res: Response): Promise<void> {
  try {
    const data = await listChannels();
    success(res, 'Channels', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to list channels', 400);
  }
}

export async function corridorsList(_req: Request, res: Response): Promise<void> {
  try {
    const data = await listCorridors();
    success(res, 'Corridors', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to list corridors', 400);
  }
}

export async function cryptoNetworksList(req: Request, res: Response): Promise<void> {
  try {
    const data = listCryptoNetworks(
      req.query.asset ? String(req.query.asset) : undefined
    );
    success(res, 'Crypto networks', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to list crypto networks', 400);
  }
}

export async function bankResolve(req: Request, res: Response): Promise<void> {
  try {
    const data = await resolveBank(
      String(req.body?.accountNumber || ''),
      String(req.body?.bankCode || req.body?.networkId || '')
    );
    success(res, 'Account resolved', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to resolve account', 400);
  }
}

function readIdempotencyKey(req: Request): string | undefined {
  const header = req.headers['idempotency-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const key = String(fromHeader || req.body?.idempotencyKey || '').trim();
  return key || undefined;
}

export async function paymentCreate(req: Request, res: Response): Promise<void> {
  try {
    const env = req.infraEnv || 'test';
    const idempotencyKey = readIdempotencyKey(req);
    if (env === 'live' && !idempotencyKey) {
      errorResponse(res, 'Idempotency-Key is required for LIVE', 400);
      return;
    }
    const data = await createCollection({
      orgId: req.infra!.orgId!,
      env,
      amount: Number(req.body?.amount),
      currency: req.body?.currency,
      country: req.body?.country,
      description: req.body?.description,
      customerName: req.body?.customerName,
      customerEmail: req.body?.customerEmail,
      channelId: req.body?.channelId,
      method: req.body?.method,
      asset: req.body?.asset,
      network: req.body?.network,
      depositAddress: req.body?.depositAddress,
      idempotencyKey,
    });
    success(res, 'Payment collection created', 201, data);
  } catch (err: any) {
    const code =
      err instanceof InfraIdempotencyError
        ? 409
        : err instanceof InfraRailError || err instanceof InfraLedgerError
          ? err.status
          : 400;
    errorResponse(res, err.message || 'Unable to create payment', code);
  }
}

export async function payoutCreate(req: Request, res: Response): Promise<void> {
  try {
    const env = req.infraEnv || 'test';
    const idempotencyKey = readIdempotencyKey(req);
    if (env === 'live' && !idempotencyKey) {
      errorResponse(res, 'Idempotency-Key is required for LIVE', 400);
      return;
    }
    const data = await createPayout({
      orgId: req.infra!.orgId!,
      env,
      amount: Number(req.body?.amount),
      currency: req.body?.currency,
      country: req.body?.country,
      accountNumber: String(req.body?.accountNumber || req.body?.walletAddress || ''),
      accountName: String(req.body?.accountName || ''),
      bankCode: String(req.body?.bankCode || req.body?.networkId || ''),
      bankName: req.body?.bankName,
      networkId: req.body?.networkId,
      channelId: req.body?.channelId,
      reason: req.body?.reason,
      recipientEmail: req.body?.recipientEmail,
      recipientPhone: req.body?.recipientPhone,
      accountType: req.body?.accountType || req.body?.method,
      asset: req.body?.asset,
      network: req.body?.network,
      walletAddress: req.body?.walletAddress,
      dayfiTag: req.body?.dayfiTag || req.body?.username || req.body?.tag,
      recipientId: req.body?.recipientId || undefined,
      destinationId: req.body?.destinationId || undefined,
      idempotencyKey,
    });
    success(res, 'Payout created', 201, data);
  } catch (err: any) {
    const code =
      err instanceof InfraIdempotencyError
        ? 409
        : err instanceof InfraRecipientError ||
            err instanceof InfraLedgerError ||
            err instanceof InfraRailError
          ? err.status
          : 400;
    errorResponse(res, err.message || 'Unable to create payout', code);
  }
}

/** Increment E — Dayfi → Dayfi ledger transfer (no Stellar). */
export async function transferCreate(req: Request, res: Response): Promise<void> {
  try {
    const env = req.infraEnv || 'test';
    const idempotencyKey = readIdempotencyKey(req);
    if (env === 'live' && !idempotencyKey) {
      errorResponse(res, 'Idempotency-Key is required for LIVE', 400);
      return;
    }
    const data = await createInternalTransfer({
      senderOrgId: req.infra!.orgId!,
      environment: env,
      amount: Number(req.body?.amount),
      recipientOrgId: req.body?.recipientOrgId || req.body?.recipient_org_id,
      recipientEnvironment: req.body?.recipientEnvironment,
      dayfiTag: req.body?.dayfiTag || req.body?.tag,
      idempotencyKey,
      reason: req.body?.reason,
      asset: req.body?.asset || req.body?.currency,
      settlementMode: req.body?.settlementMode,
    });
    success(res, 'Internal transfer completed', data.duplicate ? 200 : 201, data);
  } catch (err: any) {
    const code =
      err instanceof InfraTransferError ||
      err instanceof InfraLedgerError ||
      err instanceof InfraFeeError ||
      err instanceof InfraFeePayerError ||
      err instanceof InfraStellarAccountError
        ? err.status
        : 400;
    errorResponse(res, err.message || 'Unable to complete transfer', code);
  }
}

export async function transferGet(req: Request, res: Response): Promise<void> {
  try {
    const data = await getInternalTransfer({
      orgId: req.infra!.orgId!,
      transferId: String(req.params.id || ''),
    });
    success(res, 'Internal transfer', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTransferError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to load transfer', code);
  }
}

/** TEST only — simulate inbound credit / outbound success (+ ledger effects). */
export async function transactionSimulate(req: Request, res: Response): Promise<void> {
  try {
    const data = await simulateSettlement({
      orgId: req.infra!.orgId!,
      env: req.infraEnv || 'test',
      transactionId: String(req.params.id || ''),
    });
    success(res, 'Transaction settled (simulated)', 200, data);
  } catch (err: any) {
    const msg = err.message || 'Unable to simulate settlement';
    const code =
      err instanceof InfraLedgerError
        ? err.status
        : msg.includes('only available')
          ? 403
          : msg.includes('not found')
            ? 404
            : 400;
    errorResponse(res, msg, code);
  }
}

/** Phase 3 — org-scoped recipients (rail-agnostic destinations). */
export async function recipientsList(req: Request, res: Response): Promise<void> {
  try {
    const data = await listRecipients(req.infra!.orgId!, req.infraEnv || 'test', {
      q: req.query.q ? String(req.query.q) : undefined,
      includeArchived: String(req.query.includeArchived || '') === 'true',
    });
    success(res, 'Recipients', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to list recipients', 400);
  }
}

export async function recipientsCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const destination =
      body.destination ||
      (body.rail || body.destinationData
        ? {
            rail: body.rail,
            country: body.destinationCountry || body.country,
            currency: body.destinationCurrency || body.currency,
            provider: body.provider || body.bankName,
            label: body.label,
            isDefault: body.isDefault !== false,
            verificationStatus: body.verificationStatus,
            destinationData: body.destinationData || {
              accountNumber: body.accountNumber,
              accountName: body.accountName,
              bankCode: body.bankCode,
              bankName: body.bankName,
              phone: body.phone || body.recipientPhone,
              networkId: body.networkId,
              walletAddress: body.walletAddress,
              network: body.network,
              asset: body.asset,
              dayfiTag: body.dayfiTag,
            },
          }
        : undefined);

    const data = await createRecipient({
      orgId: req.infra!.orgId!,
      environment: req.infraEnv || 'test',
      displayName: body.displayName || body.name,
      country: body.country,
      email: body.email,
      phone: body.phone,
      metadata: body.metadata,
      destination,
    });
    success(res, 'Recipient created', 201, data);
  } catch (err: any) {
    const code = err instanceof InfraRecipientError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to create recipient', code);
  }
}

export async function recipientsGet(req: Request, res: Response): Promise<void> {
  try {
    const data = await getRecipient(
      req.infra!.orgId!,
      String(req.params.id || ''),
      req.infraEnv || 'test'
    );
    success(res, 'Recipient', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraRecipientError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to get recipient', code);
  }
}

export async function recipientsUpdate(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const data = await updateRecipient(req.infra!.orgId!, String(req.params.id || ''), {
      displayName: body.displayName || body.name,
      country: body.country,
      email: body.email,
      phone: body.phone,
      status: body.status,
      metadata: body.metadata,
    });
    success(res, 'Recipient updated', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraRecipientError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to update recipient', code);
  }
}

export async function recipientsArchive(req: Request, res: Response): Promise<void> {
  try {
    const data = await archiveRecipient(req.infra!.orgId!, String(req.params.id || ''));
    success(res, 'Recipient archived', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraRecipientError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to archive recipient', code);
  }
}

export async function destinationsCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const data = await addDestination(
      req.infra!.orgId!,
      String(req.params.id || ''),
      req.infraEnv || 'test',
      {
        rail: body.rail,
        country: body.country,
        currency: body.currency,
        provider: body.provider || body.bankName,
        label: body.label,
        isDefault: body.isDefault,
        verificationStatus: body.verificationStatus,
        destinationData: body.destinationData || {
          accountNumber: body.accountNumber,
          accountName: body.accountName,
          bankCode: body.bankCode,
          bankName: body.bankName,
          phone: body.phone,
          networkId: body.networkId,
          walletAddress: body.walletAddress,
          network: body.network,
          asset: body.asset,
          dayfiTag: body.dayfiTag,
        },
      }
    );
    success(res, 'Destination added', 201, data);
  } catch (err: any) {
    const code = err instanceof InfraRecipientError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to add destination', code);
  }
}

export async function destinationsArchive(req: Request, res: Response): Promise<void> {
  try {
    const data = await archiveDestination(
      req.infra!.orgId!,
      String(req.params.destinationId || '')
    );
    success(res, 'Destination archived', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraRecipientError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to archive destination', code);
  }
}

/** Phase 4 — Bulk batches (orchestration only; Phase 2 moves money). */
export async function bulkList(req: Request, res: Response): Promise<void> {
  try {
    const data = await listBulkBatches(
      req.infra!.orgId!,
      req.infraEnv || 'test',
      { limit: req.query.limit ? Number(req.query.limit) : undefined }
    );
    success(res, 'Bulk batches', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to list bulk batches', code);
  }
}

export async function bulkCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const data = await createBulkBatch({
      orgId: req.infra!.orgId!,
      environment: req.infraEnv || 'test',
      label: body.label || body.name,
      source: body.source || 'api',
      items: body.items || [],
      runPreflight: body.runPreflight !== false,
    });
    success(res, 'Bulk batch created', 201, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to create bulk batch', code);
  }
}

export async function bulkImportCsv(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const csvText = String(body.csv || body.csvText || body.content || '');
    const data = await importBulkCsv({
      orgId: req.infra!.orgId!,
      environment: req.infraEnv || 'test',
      csvText,
      label: body.label || body.name,
    });
    success(res, 'CSV imported', 201, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to import CSV', code);
  }
}

export async function bulkGet(req: Request, res: Response): Promise<void> {
  try {
    const data = await getBulkBatch(req.infra!.orgId!, String(req.params.id || ''));
    success(res, 'Bulk batch', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to get bulk batch', code);
  }
}

export async function bulkPreflight(req: Request, res: Response): Promise<void> {
  try {
    const data = await runPreflight(req.infra!.orgId!, String(req.params.id || ''));
    success(res, 'Preflight complete', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to run preflight', code);
  }
}

export async function bulkConfirm(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const data = await confirmBulkBatch(req.infra!.orgId!, String(req.params.id || ''), {
      autoSimulateTest: body.autoSimulateTest !== false,
    });
    success(res, 'Bulk batch confirmed', 200, data);
  } catch (err: any) {
    const code =
      err instanceof InfraBulkError || err instanceof InfraLedgerError
        ? err.status
        : 400;
    errorResponse(res, err.message || 'Unable to confirm bulk batch', code);
  }
}

export async function bulkCancel(req: Request, res: Response): Promise<void> {
  try {
    const data = await cancelBulkBatch(req.infra!.orgId!, String(req.params.id || ''));
    success(res, 'Bulk batch cancelled', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to cancel bulk batch', code);
  }
}

export async function bulkRefresh(req: Request, res: Response): Promise<void> {
  try {
    const data = await refreshBatchAggregates(
      req.infra!.orgId!,
      String(req.params.id || '')
    );
    success(res, 'Bulk batch refreshed', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraBulkError ? err.status : 400;
    errorResponse(res, err.message || 'Unable to refresh bulk batch', code);
  }
}

/**
 * Phase 2: Yellow Card webhook for Infrastructure Collect/Send.
 * Public (HMAC-verified). Credits on collection complete; finalizes/releases payouts.
 */
export async function yellowCardWebhook(req: Request, res: Response): Promise<void> {
  const raw =
    req.rawBody && req.rawBody.length
      ? req.rawBody
      : Buffer.from(JSON.stringify(req.body || {}));
  const signature = String(
    req.headers['x-yc-signature'] ||
      req.headers['x-yellowcard-signature'] ||
      req.headers['x-webhook-signature'] ||
      ''
  );

  try {
    assertYellowCardWebhookAuthenticated(raw, signature);
  } catch (err: any) {
    if (err instanceof YellowCardWebhookAuthError) {
      errorResponse(res, err.message, err.status);
      return;
    }
    errorResponse(res, err?.message || 'Webhook authentication failed', 401);
    return;
  }

  try {
    const result = await applyInfraYellowCardWebhook(req.body || {});
    success(res, result.handled ? 'Webhook processed' : 'Webhook ignored', 200, result);
  } catch (err: any) {
    console.error('[infra] yellowcard webhook error', err?.message || err);
    errorResponse(res, err?.message || 'Webhook processing failed', 500);
  }
}

/** Increment G — treasury liquidity vs customer liabilities (read-only). */
export async function treasuryGet(req: Request, res: Response): Promise<void> {
  try {
    const data = await getTreasuryPosition({
      environment: req.infraEnv || 'test',
    });
    success(res, 'Treasury position', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 500;
    errorResponse(res, err?.message || 'Unable to load treasury', code);
  }
}

/** Increment G — observe-only treasury reconciliation report. */
export async function treasuryReconcile(req: Request, res: Response): Promise<void> {
  try {
    const data = await reconcileTreasuryPosition({
      environment: req.infraEnv || 'test',
    });
    success(res, 'Treasury reconciliation', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 500;
    errorResponse(res, err?.message || 'Unable to reconcile treasury', code);
  }
}

export async function treasuryRebalancesList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await listTreasuryRebalances({
      environment: req.infraEnv || 'test',
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    success(res, 'Treasury rebalances', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 500;
    errorResponse(res, err?.message || 'Unable to list rebalances', code);
  }
}

export async function treasuryRebalanceGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await getTreasuryRebalance(String(req.params.id || ''));
    success(res, 'Treasury rebalance', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 404;
    errorResponse(res, err?.message || 'Unable to load rebalance', code);
  }
}

/**
 * Increment G — manual Dayfi treasury → treasury rebalance.
 * Body: { amount, destinationPublicKey, idempotencyKey, execute?: boolean }
 */
export async function treasuryRebalanceCreate(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const idempotencyKey = String(
      req.headers['idempotency-key'] ||
        req.body?.idempotencyKey ||
        req.body?.idempotency_key ||
        ''
    ).trim();
    if (!idempotencyKey) {
      errorResponse(res, 'Idempotency-Key is required', 400);
      return;
    }
    const execute =
      req.body?.execute === true ||
      String(req.body?.execute || '').toLowerCase() === 'true';
    const payload = {
      environment: req.infraEnv || 'test',
      amount: Number(req.body?.amount),
      destinationPublicKey: String(
        req.body?.destinationPublicKey || req.body?.destination || ''
      ),
      idempotencyKey,
      requestedBy: req.infra?.memberId || req.infra?.orgId || undefined,
      purpose: String(req.body?.purpose || 'manual'),
    };
    const data = execute
      ? await executeTreasuryRebalance(payload)
      : await requestTreasuryRebalance({ ...payload, autoApprove: false });
    success(
      res,
      execute ? 'Treasury rebalance executed' : 'Treasury rebalance requested',
      200,
      data
    );
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 400;
    errorResponse(res, err?.message || 'Unable to create rebalance', code);
  }
}

export async function treasuryRebalanceApprove(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await approveTreasuryRebalance({
      rebalanceId: String(req.params.id || ''),
      environment: req.infraEnv || 'test',
    });
    success(res, 'Treasury rebalance approved', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 400;
    errorResponse(res, err?.message || 'Unable to approve rebalance', code);
  }
}

export async function treasuryRebalanceSubmit(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await submitTreasuryRebalance({
      rebalanceId: String(req.params.id || ''),
      environment: req.infraEnv || 'test',
    });
    success(res, 'Treasury rebalance submitted', 200, data);
  } catch (err: any) {
    const code = err instanceof InfraTreasuryError ? err.status : 400;
    errorResponse(res, err?.message || 'Unable to submit rebalance', code);
  }
}
