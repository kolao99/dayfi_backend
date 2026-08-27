/**
 * Dayfi Back Office — operator auth, invite admin, audit.
 * Separate from merchant infra JWT (infra: true).
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import { Request, Response, NextFunction } from 'express';
import { db } from '../../config/database';
import HashText from '../../shared/services/hashing';
import { errorResponse } from '../../shared/lib/api-response';
import config from '../../config/env';

export type OperatorRole = 'viewer' | 'support' | 'ops' | 'treasury' | 'admin';

export type OperatorAuth = {
  operatorId: string;
  email: string;
  role: OperatorRole;
  name?: string | null;
};

export type InviteStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';

type OperatorRow = {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  role: OperatorRole;
  active: boolean;
};

type InviteRow = {
  id: string;
  code: string;
  assigned_email: string | null;
  label: string | null;
  environment: string | null;
  max_uses: number;
  uses_count: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  created_by_operator_id: string | null;
  redeemed_by_email: string | null;
  last_redeemed_at: Date | null;
};

const OPERATOR_SELECT =
  'id, email, password_hash, name, role, active';

const INVITE_SELECT = `
  id, code, assigned_email, label, environment,
  max_uses, uses_count, expires_at, revoked_at, created_at,
  created_by_operator_id, redeemed_by_email, last_redeemed_at
`;

declare global {
  namespace Express {
    interface Request {
      operator?: OperatorAuth;
    }
  }
}

function normalizeEmail(email: string): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function signOperatorToken(payload: OperatorAuth): string {
  const exp = dayjs().add(12, 'hour').unix();
  return jwt.sign(
    { data: { ...payload, infraOperator: true }, exp },
    String(config?.JWT_SECRET)
  );
}

export function decodeOperatorToken(token: string): OperatorAuth | null {
  try {
    const decoded = jwt.verify(token, String(config?.JWT_SECRET)) as {
      data?: OperatorAuth & { infraOperator?: boolean; infra?: boolean };
    };
    // Reject merchant tokens explicitly
    if (!decoded?.data?.infraOperator || decoded.data.infra) return null;
    if (!decoded.data.operatorId || !decoded.data.email || !decoded.data.role) {
      return null;
    }
    return {
      operatorId: decoded.data.operatorId,
      email: decoded.data.email,
      role: decoded.data.role,
      name: decoded.data.name ?? null,
    };
  } catch {
    return null;
  }
}

export function deriveInviteStatus(row: {
  revoked_at: Date | null;
  expires_at: Date | null;
  uses_count: number;
  max_uses: number;
}): InviteStatus {
  if (row.revoked_at) return 'REVOKED';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'EXPIRED';
  if (row.uses_count >= row.max_uses) return 'USED';
  return 'ACTIVE';
}

function serializeInvite(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    assignedEmail: row.assigned_email,
    label: row.label,
    environment: row.environment || 'both',
    maxUses: row.max_uses,
    usesCount: row.uses_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdByOperatorId: row.created_by_operator_id,
    redeemedByEmail: row.redeemed_by_email,
    lastRedeemedAt: row.last_redeemed_at,
    status: deriveInviteStatus(row),
  };
}

export async function writeOperatorAudit(input: {
  operatorId?: string | null;
  operatorEmail: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.none(
    `INSERT INTO infra_operator_audit
       (operator_id, operator_email, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.operatorId || null,
      normalizeEmail(input.operatorEmail),
      input.action,
      input.resourceType,
      input.resourceId || null,
      JSON.stringify(input.metadata || {}),
    ]
  );
}

export async function findOperatorByEmail(
  email: string
): Promise<OperatorRow | null> {
  return db.oneOrNone<OperatorRow>(
    `SELECT ${OPERATOR_SELECT} FROM infra_operators WHERE LOWER(email) = LOWER($1)`,
    [normalizeEmail(email)]
  );
}

/** Bootstrap first admin from env if table is empty (dev/ops bootstrap). */
export async function ensureBootstrapOperator(): Promise<void> {
  const email = normalizeEmail(
    process.env.DAYFI_OPERATOR_EMAIL || 'ops@dayfi.co'
  );
  const password = String(process.env.DAYFI_OPERATOR_PASSWORD || 'dayfi-ops');
  const count = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM infra_operators`
  );

  if (count.n === 0) {
    const hash = await HashText.getHash(password);
    await db.none(
      `INSERT INTO infra_operators (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [email, hash, 'Dayfi Ops']
    );
    return;
  }

  /**
   * Opt-in local recovery: when DAYFI_OPERATOR_SYNC_PASSWORD=true, reset the
   * bootstrap operator password from DAYFI_OPERATOR_PASSWORD (or default).
   * Never enabled implicitly in production.
   */
  if (String(process.env.DAYFI_OPERATOR_SYNC_PASSWORD || '') === 'true') {
    const existing = await findOperatorByEmail(email);
    if (existing) {
      const hash = await HashText.getHash(password);
      await db.none(
        `UPDATE infra_operators
         SET password_hash = $2, active = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [existing.id, hash]
      );
    }
  }
}

export async function operatorLogin(email: string, password: string) {
  await ensureBootstrapOperator();
  const row = await findOperatorByEmail(email);
  if (!row || !row.active) {
    throw new Error('Invalid email or password');
  }
  const ok = await HashText.verifyHash(password, row.password_hash);
  if (!ok) {
    throw new Error('Invalid email or password');
  }

  await db.none(
    `UPDATE infra_operators SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [row.id]
  );

  const auth: OperatorAuth = {
    operatorId: row.id,
    email: row.email,
    role: row.role,
    name: row.name,
  };
  const token = signOperatorToken(auth);
  await writeOperatorAudit({
    operatorId: row.id,
    operatorEmail: row.email,
    action: 'OPERATOR_LOGIN',
    resourceType: 'operator',
    resourceId: row.id,
  });
  return { token, operator: auth };
}

export function roleAtLeast(
  role: OperatorRole,
  allowed: OperatorRole[]
): boolean {
  return allowed.includes(role);
}

/** Invite create/revoke: ops, treasury, admin */
export const INVITE_WRITE_ROLES: OperatorRole[] = ['ops', 'treasury', 'admin'];

export async function operatorAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    errorResponse(res, 'Unauthorized', 401);
    return;
  }
  const auth = decodeOperatorToken(token);
  if (!auth) {
    errorResponse(res, 'Invalid or expired operator token', 401);
    return;
  }
  const row = await findOperatorByEmail(auth.email);
  if (!row || !row.active || row.id !== auth.operatorId) {
    errorResponse(res, 'Operator inactive or not found', 401);
    return;
  }
  req.operator = {
    operatorId: row.id,
    email: row.email,
    role: row.role,
    name: row.name,
  };
  next();
}

export function requireOperatorRoles(allowed: OperatorRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.operator?.role;
    if (!role || !roleAtLeast(role, allowed)) {
      errorResponse(res, 'Insufficient operator permissions', 403);
      return;
    }
    next();
  };
}

function generateInviteCode(): string {
  const body = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `DF-${body}`;
}

export async function listInviteCodes(query: {
  search?: string;
  status?: string;
}): Promise<ReturnType<typeof serializeInvite>[]> {
  const rows = await db.manyOrNone<InviteRow>(
    `SELECT ${INVITE_SELECT}
     FROM infra_invite_codes
     ORDER BY created_at DESC
     LIMIT 500`
  );

  let items = rows.map(serializeInvite);
  const search = String(query.search || '')
    .trim()
    .toLowerCase();
  if (search) {
    items = items.filter(
      (i) =>
        i.code.toLowerCase().includes(search) ||
        (i.assignedEmail || '').toLowerCase().includes(search) ||
        (i.label || '').toLowerCase().includes(search)
    );
  }
  const status = String(query.status || '')
    .trim()
    .toUpperCase();
  if (status && status !== 'ALL') {
    items = items.filter((i) => i.status === status);
  }
  return items;
}

export async function createInviteCode(input: {
  assignedEmail: string;
  label?: string | null;
  maxUses?: number;
  expiresInDays?: number | null;
  environment?: string | null;
  operator: OperatorAuth;
}) {
  const assignedEmail = normalizeEmail(input.assignedEmail);
  if (!assignedEmail || !assignedEmail.includes('@')) {
    throw new Error('Assigned email is required');
  }
  const maxUses = Math.max(1, Number(input.maxUses) || 1);
  const envRaw = String(input.environment || 'both').toLowerCase();
  const environment =
    envRaw === 'test' || envRaw === 'live' || envRaw === 'both' ? envRaw : 'both';

  let expiresAt: Date | null = null;
  if (input.expiresInDays != null && Number(input.expiresInDays) > 0) {
    expiresAt = dayjs()
      .add(Number(input.expiresInDays), 'day')
      .endOf('day')
      .toDate();
  }

  let code = generateInviteCode();
  for (let i = 0; i < 5; i++) {
    const clash = await db.oneOrNone(
      `SELECT id FROM infra_invite_codes WHERE UPPER(code) = UPPER($1)`,
      [code]
    );
    if (!clash) break;
    code = generateInviteCode();
  }

  const row = await db.one<InviteRow>(
    `INSERT INTO infra_invite_codes
       (code, assigned_email, label, environment, max_uses, expires_at, created_by_operator_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${INVITE_SELECT}`,
    [
      code,
      assignedEmail,
      input.label?.trim() || null,
      environment,
      maxUses,
      expiresAt,
      input.operator.operatorId,
    ]
  );

  await writeOperatorAudit({
    operatorId: input.operator.operatorId,
    operatorEmail: input.operator.email,
    action: 'INVITE_CREATED',
    resourceType: 'invite_code',
    resourceId: row.id,
    metadata: {
      code: row.code,
      assignedEmail,
      maxUses,
      environment,
      expiresAt,
    },
  });

  return serializeInvite(row);
}

export async function revokeInviteCode(
  id: string,
  operator: OperatorAuth
): Promise<ReturnType<typeof serializeInvite>> {
  const existing = await db.oneOrNone<InviteRow>(
    `SELECT ${INVITE_SELECT} FROM infra_invite_codes WHERE id = $1`,
    [id]
  );
  if (!existing) throw new Error('Invite code not found');
  if (existing.revoked_at) {
    return serializeInvite(existing);
  }

  const row = await db.one<InviteRow>(
    `UPDATE infra_invite_codes
     SET revoked_at = NOW()
     WHERE id = $1
     RETURNING ${INVITE_SELECT}`,
    [id]
  );

  await writeOperatorAudit({
    operatorId: operator.operatorId,
    operatorEmail: operator.email,
    action: 'INVITE_REVOKED',
    resourceType: 'invite_code',
    resourceId: row.id,
    metadata: { code: row.code },
  });

  return serializeInvite(row);
}

/** Load invite by code for auth flows — includes assigned email. */
export async function getInviteByCode(code: string): Promise<InviteRow | null> {
  const normalized = String(code || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  return db.oneOrNone<InviteRow>(
    `SELECT ${INVITE_SELECT} FROM infra_invite_codes WHERE UPPER(code) = $1`,
    [normalized]
  );
}

/**
 * Validate invite is ACTIVE and email matches assigned_email (no consume).
 */
export async function assertInviteAssignable(input: {
  code: string;
  email: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  const row = await getInviteByCode(input.code);
  if (!row) {
    const { checkInviteCode } = await import('./infraService');
    const ok = await checkInviteCode(input.code);
    if (!ok) throw new Error('Invalid invite code');
    return;
  }
  const status = deriveInviteStatus(row);
  if (status !== 'ACTIVE') {
    throw new Error(`Invite code is ${status.toLowerCase()}`);
  }
  if (row.assigned_email && normalizeEmail(row.assigned_email) !== email) {
    throw new Error(
      `This invite is assigned to ${row.assigned_email}. Sign up with that email.`
    );
  }
}

/**
 * Consume invite after successful check.
 * Enforces assigned_email when set.
 */
export async function redeemInviteCode(input: {
  code: string;
  email: string;
}): Promise<{ ok: true; code: string; assignedEmail: string | null }> {
  await assertInviteAssignable(input);
  const email = normalizeEmail(input.email);
  const row = await getInviteByCode(input.code);
  if (!row) {
    return {
      ok: true,
      code: String(input.code).trim().toUpperCase(),
      assignedEmail: null,
    };
  }

  const updated = await db.oneOrNone<InviteRow>(
    `UPDATE infra_invite_codes
     SET uses_count = uses_count + 1,
         redeemed_by_email = COALESCE(redeemed_by_email, $2),
         last_redeemed_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at >= NOW())
       AND uses_count < max_uses
     RETURNING ${INVITE_SELECT}`,
    [row.id, email]
  );
  if (!updated) {
    throw new Error('Invite code could not be redeemed');
  }

  await writeOperatorAudit({
    operatorEmail: email,
    action: 'INVITE_REDEEMED',
    resourceType: 'invite_code',
    resourceId: updated.id,
    metadata: {
      code: updated.code,
      redeemedByEmail: email,
      usesCount: updated.uses_count,
    },
  });

  return {
    ok: true,
    code: updated.code,
    assignedEmail: updated.assigned_email,
  };
}

export async function listOperatorAudit(limit = 100) {
  const rows = await db.manyOrNone<{
    id: string;
    operator_email: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, operator_email, action, resource_type, resource_id, metadata, created_at
     FROM infra_operator_audit
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    operatorEmail: r.operator_email,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata,
    createdAt: r.created_at,
  }));
}

/** All operator roles may read organizations/members. */
export const ORG_READ_ROLES: OperatorRole[] = [
  'viewer',
  'support',
  'ops',
  'treasury',
  'admin',
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OrgListRow = {
  id: string;
  name: string;
  slug: string;
  verification_status: string;
  created_at: Date;
  member_count: number;
  contact_email: string | null;
};

function serializeOrgListItem(row: OrgListRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    verificationStatus: row.verification_status,
    createdAt: row.created_at,
    memberCount: Number(row.member_count) || 0,
    contactEmail: row.contact_email,
  };
}

function serializeOrgDetail(
  row: {
    id: string;
    name: string;
    slug: string;
    verification_status: string;
    created_at: Date;
  },
  memberCount: number,
  contactEmail: string | null
) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    verificationStatus: row.verification_status,
    createdAt: row.created_at,
    memberCount,
    contactEmail,
  };
}

type MemberAdminRow = {
  id: string;
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  account_type: string | null;
  dayfi_tag: string | null;
  personal_onboarding_complete: boolean;
  created_at: Date;
};

function serializeMember(row: MemberAdminRow) {
  const displayName =
    [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
    row.name ||
    null;
  return {
    id: row.id,
    email: row.email,
    name: displayName,
    role: row.role,
    accountType: row.account_type || null,
    dayfiTag: row.dayfi_tag || null,
    personalOnboardingComplete: Boolean(row.personal_onboarding_complete),
    createdAt: row.created_at,
  };
}

/**
 * Cross-org organization list for Back Office.
 * Does not expose secrets, API keys, or sensitive KYC identifiers.
 */
export async function listOrganizations(query: {
  search?: string;
  verificationStatus?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  items: ReturnType<typeof serializeOrgListItem>[];
  total: number;
  limit: number;
  offset: number;
}> {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  const search = String(query.search || '').trim();
  const verification = String(query.verificationStatus || '')
    .trim()
    .toLowerCase();

  const where: string[] = [];
  const params: unknown[] = [];

  if (
    verification &&
    verification !== 'all' &&
    ['unverified', 'pending', 'verified'].includes(verification)
  ) {
    params.push(verification);
    where.push(`o.verification_status = $${params.length}`);
  }

  if (search) {
    if (UUID_RE.test(search)) {
      params.push(search);
      where.push(`o.id = $${params.length}::uuid`);
    } else {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      where.push(`(
        LOWER(o.name) LIKE $${p}
        OR LOWER(o.slug) LIKE $${p}
        OR EXISTS (
          SELECT 1 FROM infra_members m2
          WHERE m2.org_id = o.id AND LOWER(m2.email) LIKE $${p}
        )
      )`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM infra_organizations o
     ${whereSql}`,
    params
  );

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rows = await db.manyOrNone<OrgListRow>(
    `SELECT
       o.id,
       o.name,
       o.slug,
       o.verification_status,
       o.created_at,
       (SELECT COUNT(*)::int FROM infra_members m WHERE m.org_id = o.id) AS member_count,
       (
         SELECT m.email
         FROM infra_members m
         WHERE m.org_id = o.id
         ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, m.created_at ASC
         LIMIT 1
       ) AS contact_email
     FROM infra_organizations o
     ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return {
    items: rows.map(serializeOrgListItem),
    total: totalRow.n,
    limit,
    offset,
  };
}

export async function getOrganization(
  id: string
): Promise<ReturnType<typeof serializeOrgDetail>> {
  if (!UUID_RE.test(String(id || ''))) {
    throw Object.assign(new Error('Organization not found'), { status: 404 });
  }
  const row = await db.oneOrNone<{
    id: string;
    name: string;
    slug: string;
    verification_status: string;
    created_at: Date;
  }>(
    `SELECT id, name, slug, verification_status, created_at
     FROM infra_organizations WHERE id = $1`,
    [id]
  );
  if (!row) {
    throw Object.assign(new Error('Organization not found'), { status: 404 });
  }
  const counts = await db.one<{
    member_count: number;
    contact_email: string | null;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM infra_members m WHERE m.org_id = $1) AS member_count,
       (
         SELECT m.email FROM infra_members m
         WHERE m.org_id = $1
         ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, m.created_at ASC
         LIMIT 1
       ) AS contact_email`,
    [id]
  );
  return serializeOrgDetail(row, counts.member_count, counts.contact_email);
}

export async function listOrganizationMembers(
  orgId: string
): Promise<ReturnType<typeof serializeMember>[]> {
  if (!UUID_RE.test(String(orgId || ''))) {
    throw Object.assign(new Error('Organization not found'), { status: 404 });
  }
  const org = await db.oneOrNone(`SELECT id FROM infra_organizations WHERE id = $1`, [
    orgId,
  ]);
  if (!org) {
    throw Object.assign(new Error('Organization not found'), { status: 404 });
  }

  const rows = await db.manyOrNone<MemberAdminRow>(
    `SELECT id, email, name, first_name, last_name, role, account_type, dayfi_tag,
            personal_onboarding_complete, created_at
     FROM infra_members
     WHERE org_id = $1
     ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC`,
    [orgId]
  );
  return rows.map(serializeMember);
}

/** Same roles as org read — transactions are operator-read-only. */
export const TX_READ_ROLES: OperatorRole[] = ORG_READ_ROLES;

type TxAdminRow = {
  id: string;
  org_id: string;
  org_name: string | null;
  environment: string;
  amount: string;
  currency: string;
  country: string | null;
  status: string;
  method: string | null;
  direction: string;
  fee: string;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

const SECRET_META_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'secret',
  'privateKey',
  'private_key',
  'seed',
  'mnemonic',
  'bvn',
  'otp',
  'otpCode',
  'apiKey',
  'api_key',
  'secretKey',
  'secret_key',
  'accountNumber',
  'account_number',
  'accountNo',
  'iban',
  'routingNumber',
];

function scrubMetadata(
  meta: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!meta || typeof meta !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const lower = k.toLowerCase();
    if (SECRET_META_KEYS.some((s) => lower.includes(s.toLowerCase()))) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrubMetadata(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function extractCounterparty(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const saved = (meta.savedRecipient || {}) as Record<string, unknown>;
  const rec = (meta.recipient || {}) as Record<string, unknown>;
  const candidates = [
    saved.recipientName,
    rec.accountName,
    rec.name,
    meta.originatorName,
    meta.originator,
    meta.senderName,
    meta.counterparty,
    meta.displayName,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  const hint = saved.displayHint || rec.displayHint;
  if (hint != null && String(hint).trim()) return String(hint).trim();
  return null;
}

function extractRail(
  method: string | null,
  meta: Record<string, unknown> | null
): string | null {
  if (!meta) return method || null;
  const saved = (meta.savedRecipient || {}) as Record<string, unknown>;
  const candidates = [meta.rail, saved.rail, meta.settlementRail, method];
  for (const c of candidates) {
    if (c != null && String(c).trim() && String(c).toLowerCase() !== 'null') {
      return String(c).trim();
    }
  }
  return method || null;
}

function extractProvider(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const candidates = [
    meta.provider,
    meta.providerName,
    (meta.offRamp as Record<string, unknown> | undefined)?.provider,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() && String(c).toLowerCase() !== 'null') {
      return String(c).trim();
    }
  }
  return null;
}

/** Masked destination only — never full account numbers. */
function extractDestination(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const saved = (meta.savedRecipient || {}) as Record<string, unknown>;
  const rec = (meta.recipient || {}) as Record<string, unknown>;
  const hint = saved.displayHint || rec.displayHint;
  if (hint != null && String(hint).trim()) return String(hint).trim();
  const bank = rec.bankName || saved.bankName;
  if (bank != null && String(bank).trim()) return String(bank).trim();
  return null;
}

function extractRecipient(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const saved = (meta.savedRecipient || {}) as Record<string, unknown>;
  const rec = (meta.recipient || {}) as Record<string, unknown>;
  const candidates = [saved.recipientName, rec.accountName, rec.name];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return null;
}

function serializeAdminTransaction(row: TxAdminRow, { detail = false } = {}) {
  const meta = (row.metadata || {}) as Record<string, unknown>;
  const scrubbed = scrubMetadata(meta);
  const base = {
    id: row.id,
    transactionId: row.id,
    orgId: row.org_id,
    organizationId: row.org_id,
    organizationName: row.org_name,
    environment: row.environment,
    amount: row.amount,
    currency: row.currency,
    country: row.country,
    status: row.status,
    method: row.method,
    type: row.direction,
    direction: row.direction,
    fee: row.fee,
    externalId: row.external_id,
    reference: row.external_id || row.id,
    counterparty: extractCounterparty(meta),
    recipient: extractRecipient(meta),
    destination: extractDestination(meta),
    rail: extractRail(row.method, meta),
    provider: extractProvider(meta),
    createdAt: row.created_at,
    updatedAt:
      (typeof meta.settledAt === 'string' && meta.settledAt) ||
      (typeof meta.updatedAt === 'string' && meta.updatedAt) ||
      null,
  };
  if (detail) {
    return { ...base, metadata: scrubbed };
  }
  return base;
}

/**
 * Cross-org transaction list for Back Office (read-only).
 * Amounts are returned as stored — no new rounding/FX.
 */
export async function listAdminTransactions(query: {
  search?: string;
  orgId?: string;
  type?: string;
  status?: string;
  currency?: string;
  environment?: string;
  method?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  page?: number;
}): Promise<{
  items: ReturnType<typeof serializeAdminTransaction>[];
  total: number;
  limit: number;
  offset: number;
  page: number;
  hasNext: boolean;
}> {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  let offset = Math.max(0, Number(query.offset) || 0);
  const pageNum = Math.max(1, Number(query.page) || 0);
  if (pageNum > 0 && query.offset == null) {
    offset = (pageNum - 1) * limit;
  }

  const where: string[] = [];
  const params: unknown[] = [];

  const orgId = String(query.orgId || '').trim();
  if (orgId) {
    if (!UUID_RE.test(orgId)) {
      return { items: [], total: 0, limit, offset, page: 1, hasNext: false };
    }
    params.push(orgId);
    where.push(`t.org_id = $${params.length}::uuid`);
  }

  const type = String(query.type || '').trim().toLowerCase();
  const allowedTypes = [
    'payment',
    'payout',
    'settlement',
    'fee',
    'other',
    'deposit',
    'internal_transfer',
  ];
  if (type && type !== 'all' && allowedTypes.includes(type)) {
    params.push(type);
    where.push(`t.direction = $${params.length}`);
  }

  const status = String(query.status || '').trim().toLowerCase();
  if (status && status !== 'all') {
    params.push(status);
    where.push(`LOWER(t.status) = $${params.length}`);
  }

  const currency = String(query.currency || '').trim().toUpperCase();
  if (currency && currency !== 'ALL') {
    params.push(currency);
    where.push(`UPPER(t.currency) = $${params.length}`);
  }

  const environment = String(query.environment || '').trim().toLowerCase();
  if (environment === 'test' || environment === 'live') {
    params.push(environment);
    where.push(`t.environment = $${params.length}`);
  }

  const method = String(query.method || '')
    .trim()
    .toLowerCase();
  if (method && method !== 'all') {
    params.push(`%${method}%`);
    const p = params.length;
    where.push(`(
      LOWER(COALESCE(t.method, '')) LIKE $${p}
      OR LOWER(COALESCE(t.metadata->>'rail', '')) LIKE $${p}
      OR LOWER(COALESCE(t.metadata->'savedRecipient'->>'rail', '')) LIKE $${p}
    )`);
  }

  const from = String(query.from || '').trim();
  if (from) {
    params.push(from);
    where.push(`t.created_at >= $${params.length}::timestamptz`);
  }
  const to = String(query.to || '').trim();
  if (to) {
    params.push(to);
    where.push(`t.created_at <= $${params.length}::timestamptz`);
  }

  const search = String(query.search || '').trim();
  if (search) {
    if (UUID_RE.test(search)) {
      params.push(search);
      where.push(
        `(t.id = $${params.length}::uuid OR t.org_id = $${params.length}::uuid)`
      );
    } else {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      where.push(`(
        LOWER(COALESCE(t.external_id, '')) LIKE $${p}
        OR LOWER(t.status) LIKE $${p}
        OR LOWER(t.direction) LIKE $${p}
        OR LOWER(COALESCE(t.method, '')) LIKE $${p}
        OR LOWER(o.name) LIKE $${p}
        OR LOWER(t.metadata::text) LIKE $${p}
      )`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM infra_transactions t
     JOIN infra_organizations o ON o.id = t.org_id
     ${whereSql}`,
    params
  );

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rows = await db.manyOrNone<TxAdminRow>(
    `SELECT
       t.id::text AS id,
       t.org_id::text AS org_id,
       o.name AS org_name,
       t.environment,
       t.amount::text AS amount,
       t.currency,
       t.country,
       t.status,
       t.method,
       t.direction,
       t.fee::text AS fee,
       t.external_id,
       t.metadata,
       t.created_at
     FROM infra_transactions t
     JOIN infra_organizations o ON o.id = t.org_id
     ${whereSql}
     ORDER BY t.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const page = Math.floor(offset / limit) + 1;
  return {
    items: rows.map((r) => serializeAdminTransaction(r)),
    total: totalRow.n,
    limit,
    offset,
    page,
    hasNext: offset + limit < totalRow.n,
  };
}

export async function getAdminTransaction(
  id: string
): Promise<ReturnType<typeof serializeAdminTransaction>> {
  if (!UUID_RE.test(String(id || ''))) {
    throw Object.assign(new Error('Transaction not found'), { status: 404 });
  }
  const row = await db.oneOrNone<TxAdminRow>(
    `SELECT
       t.id::text AS id,
       t.org_id::text AS org_id,
       o.name AS org_name,
       t.environment,
       t.amount::text AS amount,
       t.currency,
       t.country,
       t.status,
       t.method,
       t.direction,
       t.fee::text AS fee,
       t.external_id,
       t.metadata,
       t.created_at
     FROM infra_transactions t
     JOIN infra_organizations o ON o.id = t.org_id
     WHERE t.id = $1`,
    [id]
  );
  if (!row) {
    throw Object.assign(new Error('Transaction not found'), { status: 404 });
  }
  return serializeAdminTransaction(row, { detail: true });
}

/** Collections = inbound payments (direction=payment) over infra_transactions. */
export const COLLECTION_READ_ROLES: OperatorRole[] = TX_READ_ROLES;
export const PAYOUT_READ_ROLES: OperatorRole[] = TX_READ_ROLES;

export async function listAdminCollections(
  query: Omit<Parameters<typeof listAdminTransactions>[0], 'type'>
) {
  return listAdminTransactions({ ...query, type: 'payment' });
}

export async function getAdminCollection(id: string) {
  const item = await getAdminTransaction(id);
  if (item.direction !== 'payment') {
    throw Object.assign(new Error('Collection not found'), { status: 404 });
  }
  return item;
}

export async function listAdminPayouts(
  query: Omit<Parameters<typeof listAdminTransactions>[0], 'type'>
) {
  return listAdminTransactions({ ...query, type: 'payout' });
}

export async function getAdminPayout(id: string) {
  const item = await getAdminTransaction(id);
  if (item.direction !== 'payout') {
    throw Object.assign(new Error('Payout not found'), { status: 404 });
  }
  return item;
}

/** Same read roles as transactions. */
export const WALLET_READ_ROLES: OperatorRole[] = TX_READ_ROLES;

type WalletAdminRow = {
  id: string;
  org_id: string;
  org_name: string | null;
  environment: string;
  asset: string;
  status: string;
  available: string;
  pending: string;
  locked: string;
  created_at: Date;
  updated_at: Date;
};

type LedgerMovementAdminRow = {
  id: string;
  wallet_account_id: string;
  direction: string;
  amount: string;
  asset: string;
  movement_type: string;
  reference: string | null;
  reference_type: string | null;
  reference_id: string | null;
  available_after: string;
  pending_after: string;
  locked_after: string;
  created_at: Date;
  metadata: Record<string, unknown> | null;
};

function walletTotal(available: string, pending: string, locked: string): string {
  const sum =
    (Number(available) || 0) + (Number(pending) || 0) + (Number(locked) || 0);
  // Keep 7dp string form aligned with ledger numeric storage display
  return sum.toFixed(7);
}

function serializeAdminWallet(row: WalletAdminRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    organizationId: row.org_id,
    organizationName: row.org_name,
    environment: row.environment,
    currency: row.asset,
    asset: row.asset,
    status: row.status,
    available: row.available,
    pending: row.pending,
    locked: row.locked,
    total: walletTotal(row.available, row.pending, row.locked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeLedgerMovement(row: LedgerMovementAdminRow) {
  return {
    id: row.id,
    walletAccountId: row.wallet_account_id,
    direction: row.direction,
    amount: row.amount,
    asset: row.asset,
    type: row.movement_type,
    movementType: row.movement_type,
    reference: row.reference || row.reference_id || null,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    availableAfter: row.available_after,
    pendingAfter: row.pending_after,
    lockedAfter: row.locked_after,
    createdAt: row.created_at,
    metadata: scrubMetadata(row.metadata),
  };
}

/**
 * Cross-org wallet list. Balances are the stored projection on
 * infra_wallet_accounts (same rows getOrgBalance reads). Never creates wallets.
 */
export async function listAdminWallets(query: {
  search?: string;
  orgId?: string;
  environment?: string;
  currency?: string;
  limit?: number;
  offset?: number;
  page?: number;
}): Promise<{
  items: ReturnType<typeof serializeAdminWallet>[];
  total: number;
  limit: number;
  offset: number;
  page: number;
  hasNext: boolean;
}> {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  let offset = Math.max(0, Number(query.offset) || 0);
  const pageNum = Math.max(1, Number(query.page) || 0);
  if (pageNum > 0 && query.offset == null) {
    offset = (pageNum - 1) * limit;
  }

  const where: string[] = [];
  const params: unknown[] = [];

  const orgId = String(query.orgId || '').trim();
  if (orgId) {
    if (!UUID_RE.test(orgId)) {
      return { items: [], total: 0, limit, offset, page: 1, hasNext: false };
    }
    params.push(orgId);
    where.push(`w.org_id = $${params.length}::uuid`);
  }

  const environment = String(query.environment || '').trim().toLowerCase();
  if (environment === 'test' || environment === 'live') {
    params.push(environment);
    where.push(`w.environment = $${params.length}`);
  }

  const currency = String(query.currency || '')
    .trim()
    .toUpperCase();
  if (currency && currency !== 'ALL') {
    params.push(currency);
    where.push(`UPPER(w.asset) = $${params.length}`);
  }

  const search = String(query.search || '').trim();
  if (search) {
    if (UUID_RE.test(search)) {
      params.push(search);
      where.push(
        `(w.id = $${params.length}::uuid OR w.org_id = $${params.length}::uuid)`
      );
    } else {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      where.push(`(
        LOWER(o.name) LIKE $${p}
        OR LOWER(w.asset) LIKE $${p}
        OR LOWER(w.environment) LIKE $${p}
        OR LOWER(w.status) LIKE $${p}
      )`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM infra_wallet_accounts w
     JOIN infra_organizations o ON o.id = w.org_id
     ${whereSql}`,
    params
  );

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rows = await db.manyOrNone<WalletAdminRow>(
    `SELECT
       w.id::text AS id,
       w.org_id::text AS org_id,
       o.name AS org_name,
       w.environment,
       w.asset,
       w.status,
       w.available::text AS available,
       w.pending::text AS pending,
       w.locked::text AS locked,
       w.created_at,
       w.updated_at
     FROM infra_wallet_accounts w
     JOIN infra_organizations o ON o.id = w.org_id
     ${whereSql}
     ORDER BY w.updated_at DESC, w.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const page = Math.floor(offset / limit) + 1;
  return {
    items: rows.map(serializeAdminWallet),
    total: totalRow.n,
    limit,
    offset,
    page,
    hasNext: offset + limit < totalRow.n,
  };
}

/**
 * Wallet detail + ledger movements.
 * Balance fields are refreshed via getOrgBalance (merchant projection) when possible.
 */
export async function getAdminWallet(id: string): Promise<{
  item: ReturnType<typeof serializeAdminWallet> & {
    projectionSource: 'getOrgBalance' | 'wallet_row';
  };
  movements: ReturnType<typeof serializeLedgerMovement>[];
}> {
  if (!UUID_RE.test(String(id || ''))) {
    throw Object.assign(new Error('Wallet not found'), { status: 404 });
  }

  const row = await db.oneOrNone<WalletAdminRow>(
    `SELECT
       w.id::text AS id,
       w.org_id::text AS org_id,
       o.name AS org_name,
       w.environment,
       w.asset,
       w.status,
       w.available::text AS available,
       w.pending::text AS pending,
       w.locked::text AS locked,
       w.created_at,
       w.updated_at
     FROM infra_wallet_accounts w
     JOIN infra_organizations o ON o.id = w.org_id
     WHERE w.id = $1`,
    [id]
  );
  if (!row) {
    throw Object.assign(new Error('Wallet not found'), { status: 404 });
  }

  let item = serializeAdminWallet(row);
  let projectionSource: 'getOrgBalance' | 'wallet_row' = 'wallet_row';

  try {
    const { getOrgBalance } = await import('./infraLedgerService');
    const bal = await getOrgBalance(
      row.org_id,
      row.environment as 'test' | 'live',
      row.asset
    );
    if (bal.walletAccountId === row.id) {
      item = {
        ...item,
        available: Number(bal.available).toFixed(7),
        pending: Number(bal.pending).toFixed(7),
        locked: Number(bal.locked).toFixed(7),
        total: walletTotal(
          Number(bal.available).toFixed(7),
          Number(bal.pending).toFixed(7),
          Number(bal.locked).toFixed(7)
        ),
        status: bal.status || item.status,
      };
      projectionSource = 'getOrgBalance';
    }
  } catch {
    /* closed/unavailable — keep stored row balances */
  }

  const movements = await db.manyOrNone<LedgerMovementAdminRow>(
    `SELECT
       id::text AS id,
       wallet_account_id::text AS wallet_account_id,
       direction,
       amount::text AS amount,
       asset,
       movement_type,
       reference,
       reference_type,
       reference_id,
       available_after::text AS available_after,
       pending_after::text AS pending_after,
       locked_after::text AS locked_after,
       created_at,
       metadata
     FROM infra_ledger_movements
     WHERE wallet_account_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [id]
  );

  return {
    item: { ...item, projectionSource },
    movements: movements.map(serializeLedgerMovement),
  };
}
