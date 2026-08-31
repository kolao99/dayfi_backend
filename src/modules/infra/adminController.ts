import { Request, Response, NextFunction } from 'express';
import { success, errorResponse } from './infraService';
import {
  operatorLogin,
  listInviteCodes,
  createInviteCode,
  revokeInviteCode,
  listOperatorAudit,
  listOrganizations,
  getOrganization,
  updateOrganizationVerificationStatus,
  listOrganizationMembers,
  listAdminTransactions,
  getAdminTransaction,
  listAdminCollections,
  getAdminCollection,
  listAdminPayouts,
  getAdminPayout,
  listAdminWallets,
  getAdminWallet,
  INVITE_WRITE_ROLES,
  ORG_READ_ROLES,
  ORG_WRITE_ROLES,
  TX_READ_ROLES,
  WALLET_READ_ROLES,
  COLLECTION_READ_ROLES,
  PAYOUT_READ_ROLES,
} from './infraAdminService';
import { listAdminWebhookEndpoints } from './infraWebhookService';

export async function adminOperatorLogin(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const email = String(req.body?.email || '');
    const password = String(req.body?.password || '');
    const data = await operatorLogin(email, password);
    success(res, 'Operator signed in', 200, data);
  } catch (err: any) {
    errorResponse(res, err.message || 'Login failed', 401);
  }
}

export async function adminOperatorMe(
  req: Request,
  res: Response
): Promise<void> {
  success(res, 'Operator profile', 200, { operator: req.operator });
}

export async function adminInviteCodesList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const items = await listInviteCodes({
      search: String(req.query.search || ''),
      status: String(req.query.status || ''),
    });
    success(res, 'Invite codes', 200, { items });
  } catch (err) {
    next(err);
  }
}

export async function adminInviteCodesCreate(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!req.operator) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }
    const item = await createInviteCode({
      assignedEmail: String(req.body?.assignedEmail || req.body?.assigned_email || ''),
      label: req.body?.label ?? null,
      maxUses: req.body?.maxUses ?? req.body?.max_uses,
      expiresInDays: req.body?.expiresInDays ?? req.body?.expires_in_days,
      environment: req.body?.environment ?? 'both',
      operator: req.operator,
    });
    success(res, 'Invite code created', 201, { item });
  } catch (err: any) {
    errorResponse(res, err.message || 'Unable to create invite', 400);
  }
}

export async function adminInviteCodesRevoke(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!req.operator) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }
    const item = await revokeInviteCode(String(req.params.id), req.operator);
    success(res, 'Invite code revoked', 200, { item });
  } catch (err: any) {
    const status = err.message === 'Invite code not found' ? 404 : 400;
    errorResponse(res, err.message || 'Unable to revoke invite', status);
  }
}

export async function adminAuditList(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const items = await listOperatorAudit(100);
    success(res, 'Operator audit', 200, { items });
  } catch (err) {
    next(err);
  }
}

export async function adminOrganizationsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listOrganizations({
      search: String(req.query.search || ''),
      verificationStatus: String(
        req.query.verificationStatus || req.query.verification_status || ''
      ),
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      offset: req.query.offset != null ? Number(req.query.offset) : undefined,
    });
    success(res, 'Organizations', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function adminOrganizationGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const item = await getOrganization(String(req.params.id));
    success(res, 'Organization', 200, { item });
  } catch (err: any) {
    const status =
      err.status || (err.message === 'Organization not found' ? 404 : 400);
    errorResponse(res, err.message || 'Unable to load organization', status);
  }
}

export async function adminOrganizationMembers(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const items = await listOrganizationMembers(String(req.params.id));
    success(res, 'Organization members', 200, { items });
  } catch (err: any) {
    const status =
      err.status || (err.message === 'Organization not found' ? 404 : 400);
    errorResponse(res, err.message || 'Unable to load members', status);
  }
}

export async function adminOrganizationUpdateVerification(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!req.operator) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }
    const verificationStatus = String(
      req.body?.verificationStatus || req.body?.verification_status || ''
    );
    const item = await updateOrganizationVerificationStatus({
      orgId: String(req.params.id),
      verificationStatus,
      operator: req.operator,
    });
    success(res, 'Organization verification updated', 200, { item });
  } catch (err: any) {
    const status =
      err.status ||
      (err.message === 'Organization not found'
        ? 404
        : err.message === 'Invalid verification status'
          ? 400
          : 400);
    errorResponse(res, err.message || 'Unable to update verification', status);
  }
}

export async function adminTransactionsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listAdminTransactions({
      search: String(req.query.search || ''),
      orgId: String(req.query.orgId || req.query.org_id || ''),
      type: String(req.query.type || req.query.direction || ''),
      status: String(req.query.status || ''),
      currency: String(req.query.currency || ''),
      environment: String(req.query.environment || req.query.env || ''),
      method: String(req.query.method || req.query.rail || ''),
      from: String(req.query.from || ''),
      to: String(req.query.to || ''),
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      offset: req.query.offset != null ? Number(req.query.offset) : undefined,
      page: req.query.page != null ? Number(req.query.page) : undefined,
    });
    success(res, 'Transactions', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function adminTransactionGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const item = await getAdminTransaction(String(req.params.id));
    success(res, 'Transaction', 200, { item });
  } catch (err: any) {
    const status =
      err.status || (err.message === 'Transaction not found' ? 404 : 400);
    errorResponse(res, err.message || 'Unable to load transaction', status);
  }
}

export async function adminWalletsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listAdminWallets({
      search: String(req.query.search || ''),
      orgId: String(req.query.orgId || req.query.org_id || ''),
      environment: String(req.query.environment || req.query.env || ''),
      currency: String(req.query.currency || req.query.asset || ''),
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      offset: req.query.offset != null ? Number(req.query.offset) : undefined,
      page: req.query.page != null ? Number(req.query.page) : undefined,
    });
    success(res, 'Wallets', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function adminWalletGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const data = await getAdminWallet(String(req.params.id));
    success(res, 'Wallet', 200, data);
  } catch (err: any) {
    const status =
      err.status || (err.message === 'Wallet not found' ? 404 : 400);
    errorResponse(res, err.message || 'Unable to load wallet', status);
  }
}

function parseMoneyListQuery(req: Request) {
  return {
    search: String(req.query.search || ''),
    orgId: String(req.query.orgId || req.query.org_id || ''),
    status: String(req.query.status || ''),
    currency: String(req.query.currency || ''),
    environment: String(req.query.environment || req.query.env || ''),
    method: String(req.query.method || req.query.rail || ''),
    from: String(req.query.from || ''),
    to: String(req.query.to || ''),
    limit: req.query.limit != null ? Number(req.query.limit) : undefined,
    offset: req.query.offset != null ? Number(req.query.offset) : undefined,
    page: req.query.page != null ? Number(req.query.page) : undefined,
  };
}

export async function adminCollectionsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listAdminCollections(parseMoneyListQuery(req));
    success(res, 'Collections', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function adminCollectionGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const item = await getAdminCollection(String(req.params.id));
    success(res, 'Collection', 200, { item });
  } catch (err: any) {
    const status =
      err.status || (err.message === 'Collection not found' ? 404 : 400);
    errorResponse(res, err.message || 'Unable to load collection', status);
  }
}

export async function adminPayoutsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listAdminPayouts(parseMoneyListQuery(req));
    success(res, 'Payouts', 200, data);
  } catch (err) {
    next(err);
  }
}

export async function adminPayoutGet(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const item = await getAdminPayout(String(req.params.id));
    success(res, 'Payout', 200, { item });
  } catch (err: any) {
    const status =
      err.status || (err.message === 'Payout not found' ? 404 : 400);
    errorResponse(res, err.message || 'Unable to load payout', status);
  }
}

export async function adminWebhookEndpointsList(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await listAdminWebhookEndpoints({
      search: String(req.query.search || ''),
      orgId: String(req.query.orgId || req.query.org_id || ''),
      environment: String(req.query.environment || req.query.env || ''),
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
      offset: req.query.offset != null ? Number(req.query.offset) : undefined,
    });
    success(res, 'Webhook endpoints', 200, data);
  } catch (err) {
    next(err);
  }
}

export {
  INVITE_WRITE_ROLES,
  ORG_READ_ROLES,
  ORG_WRITE_ROLES,
  TX_READ_ROLES,
  WALLET_READ_ROLES,
  COLLECTION_READ_ROLES,
  PAYOUT_READ_ROLES,
};
