import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import config from '../../config/env';
import HashText from '../../shared/services/hashing';
import { db } from '../../config/database';
import { errorResponse, success } from '../../shared/lib/api-response';
import { sendVerificationEmail } from '../../config/email';
import { buildOtpEmail } from '../../config/email/templates';
import { verifyGoogleAuthToken } from '../authentication/googleVerify';
import { convertAmountToUsd, resolveExchangeRate } from '../payment/fxService';
import { bootstrapOrgWallets } from './infraLedgerService';

export type InfraAuth = {
  memberId: string;
  orgId: string | null;
  email: string;
  role: string;
};

declare global {
  namespace Express {
    interface Request {
      infra?: InfraAuth;
      infraEnv?: 'test' | 'live';
      rawBody?: Buffer;
    }
  }
}

function envFromHeader(req: Request): 'test' | 'live' {
  const raw = String(req.headers['x-dayfi-environment'] || 'test')
    .trim()
    .toLowerCase();
  return raw === 'live' ? 'live' : 'test';
}

function envInviteCodes(): string[] {
  const raw = String(process.env.DAYFI_INFRA_INVITE_CODES || 'DAYFI-INFRA,DAYFI,BUILD');
  return raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

export function hashApiKey(secret: string): string {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export function isApiKeySecret(token: string): boolean {
  return /^sk_(test|live)_/.test(String(token || '').trim());
}

export type InfraApiKeyAuth = {
  infra: InfraAuth;
  env: 'test' | 'live';
  keyId: string;
};

/** Bearer sk_test_ / sk_live_ → SHA-256 lookup → org/env context. */
export async function authenticateApiKey(secret: string): Promise<InfraApiKeyAuth | null> {
  const token = String(secret || '').trim();
  if (!isApiKeySecret(token)) return null;

  const row = await db.oneOrNone<{
    id: string;
    org_id: string;
    environment: string;
    created_by: string | null;
    member_id: string | null;
    email: string | null;
    role: string | null;
  }>(
    `SELECT k.id::text AS id,
            k.org_id::text AS org_id,
            k.environment,
            k.created_by::text AS created_by,
            m.id::text AS member_id,
            m.email,
            m.role
     FROM infra_api_keys k
     LEFT JOIN infra_members m ON m.id = k.created_by
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL
     LIMIT 1`,
    [hashApiKey(token)]
  );
  if (!row?.org_id) return null;

  const env: 'test' | 'live' = row.environment === 'live' ? 'live' : 'test';
  if (token.startsWith('sk_live_') && env !== 'live') return null;
  if (token.startsWith('sk_test_') && env !== 'test') return null;

  await db.none(`UPDATE infra_api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]);

  return {
    keyId: row.id,
    env,
    infra: {
      memberId: row.member_id || row.created_by || row.org_id,
      orgId: row.org_id,
      email: row.email || 'api-key',
      role: row.role || 'admin',
    },
  };
}

function generateApiSecret(env: 'test' | 'live'): {
  secret: string;
  prefix: string;
  lastFour: string;
} {
  const prefix = env === 'live' ? 'sk_live_' : 'sk_test_';
  const body = crypto.randomBytes(24).toString('hex');
  const secret = `${prefix}${body}`;
  return { secret, prefix, lastFour: body.slice(-4) };
}

function signInfraToken(payload: InfraAuth): string {
  const exp = dayjs().add(30, 'day').unix();
  return jwt.sign({ data: { ...payload, infra: true }, exp }, String(config?.JWT_SECRET));
}

function decodeInfraToken(token: string): InfraAuth | null {
  try {
    const decoded = jwt.verify(token, String(config?.JWT_SECRET)) as {
      data?: InfraAuth & { infra?: boolean };
    };
    if (!decoded?.data?.infra || !decoded.data.memberId) return null;
    return {
      memberId: decoded.data.memberId,
      orgId: decoded.data.orgId ?? null,
      email: decoded.data.email,
      role: decoded.data.role,
    };
  } catch {
    return null;
  }
}

function normalizeEmail(email: string): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

function slugify(name: string): string {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'org';
}

function shouldReturnDevOtp(): boolean {
  return (
    process.env.DAYFI_INFRA_RETURN_OTP === 'true' ||
    process.env.NODE_ENV !== 'production'
  );
}

type MemberRow = {
  id: string;
  org_id: string | null;
  email: string;
  name: string | null;
  role: string;
  password_hash: string | null;
  google_sub: string | null;
  first_name?: string | null;
  last_name?: string | null;
  account_type?: string | null;
  dayfi_tag?: string | null;
  phone?: string | null;
  date_of_birth?: Date | string | null;
  country?: string | null;
  address?: string | null;
  bvn?: string | null;
  kyc_level?: number | null;
  personal_onboarding_complete?: boolean | null;
};

type OtpPurpose = 'login' | 'signup' | 'password_reset' | 'google';

const MEMBER_SELECT = `id, org_id, email, name, role, password_hash, google_sub, first_name, last_name,
  account_type, dayfi_tag, phone, date_of_birth, country, address, bvn, kyc_level, personal_onboarding_complete`;

async function findMemberByEmail(email: string): Promise<MemberRow | null> {
  return db.oneOrNone<MemberRow>(
    `SELECT ${MEMBER_SELECT}
     FROM infra_members WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
}

function normalizeDayfiTag(raw: string) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '');
}

function validateDayfiTag(tag: string) {
  if (tag.length < 3 || tag.length > 30) {
    throw new Error('Dayfi tag must be 3–30 characters');
  }
  if (!/^[a-z0-9][a-z0-9._]*[a-z0-9]$|^[a-z0-9]{3,30}$/.test(tag)) {
    throw new Error('Dayfi tag can only use letters, numbers, dots, and underscores');
  }
}

function accountNeeds(member: MemberRow) {
  const accountType = String(member.account_type || 'business').toLowerCase();
  const isIndividual = accountType === 'individual';
  const personalDone = Boolean(member.personal_onboarding_complete);
  return {
    accountType: isIndividual ? ('individual' as const) : ('business' as const),
    needsPersonalSetup: isIndividual && !personalDone,
    needsOrgSetup: !isIndividual && !member.org_id,
    dayfiTag: member.dayfi_tag || null,
    kycLevel: Number(member.kyc_level || 1),
  };
}

function validatePassword(password: string) {
  const p = String(password || '');
  if (p.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) {
    throw new Error('Password must include at least one letter and one number');
  }
}

async function sessionPayload(member: MemberRow) {
  let orgName: string | null = null;
  let verificationStatus: string | null = null;
  if (member.org_id) {
    const org = await db.oneOrNone<{ name: string; verification_status: string }>(
      `SELECT name, verification_status FROM infra_organizations WHERE id = $1`,
      [member.org_id]
    );
    orgName = org?.name ?? null;
    verificationStatus = org?.verification_status ?? null;
  }

  const displayName =
    member.name ||
    [member.first_name, member.last_name].filter(Boolean).join(' ') ||
    member.email.split('@')[0];

  const needs = accountNeeds(member);

  const auth: InfraAuth = {
    memberId: member.id,
    orgId: member.org_id,
    email: member.email,
    role: member.role,
  };

  return {
    token: signInfraToken(auth),
    user: {
      email: member.email,
      name: displayName,
      org: orgName,
      orgId: member.org_id,
      role: member.role,
      accountType: needs.accountType,
      dayfiTag: needs.dayfiTag,
      kycLevel: needs.kycLevel,
      needsPersonalSetup: needs.needsPersonalSetup,
      needsOrgSetup: needs.needsOrgSetup,
      verificationStatus,
    },
  };
}

async function issueAndSendOtp(
  memberId: string,
  email: string,
  purpose: OtpPurpose
) {
  const otp = generateOtp();
  const expires = dayjs().add(30, 'minute').toDate();
  await db.none(
    `UPDATE infra_members
     SET otp_code = $1, otp_expires_at = $2, otp_purpose = $3
     WHERE id = $4`,
    [otp, expires, purpose, memberId]
  );

  console.log(`[infra-auth] OTP (${purpose}) for ${email}: ${otp}`);

  const mail = buildOtpEmail(otp, purpose, 30);

  try {
    await sendVerificationEmail(
      email,
      mail.subject,
      mail.text,
      mail.html,
      { throwOnFailure: false }
    );
  } catch (err) {
    console.error('[infra-auth] OTP email failed', err);
  }

  return {
    email,
    otpSent: true,
    requiresOtp: true,
    purpose,
    ...(shouldReturnDevOtp() ? { devOtp: otp } : {}),
  };
}

function signResetToken(memberId: string, email: string): string {
  const exp = dayjs().add(15, 'minute').unix();
  return jwt.sign(
    { data: { memberId, email, infraReset: true }, exp },
    String(config?.JWT_SECRET)
  );
}

function decodeResetToken(token: string): { memberId: string; email: string } | null {
  try {
    const decoded = jwt.verify(token, String(config?.JWT_SECRET)) as {
      data?: { memberId?: string; email?: string; infraReset?: boolean };
    };
    if (!decoded?.data?.infraReset || !decoded.data.memberId || !decoded.data.email) {
      return null;
    }
    return { memberId: decoded.data.memberId, email: decoded.data.email };
  } catch {
    return null;
  }
}

export async function checkInviteCode(code: string): Promise<boolean> {
  const normalized = String(code || '')
    .trim()
    .toUpperCase();
  if (!normalized) return false;
  if (envInviteCodes().includes(normalized)) return true;

  const row = await db.oneOrNone<{
    max_uses: number;
    uses_count: number;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT max_uses, uses_count, expires_at, revoked_at
     FROM infra_invite_codes WHERE UPPER(code) = $1`,
    [normalized]
  );

  if (!row || row.revoked_at) return false;
  if (row.expires_at && row.expires_at < new Date()) return false;
  if (row.uses_count >= row.max_uses) return false;
  return true;
}

export async function verifyInviteCode(code: string): Promise<boolean> {
  const ok = await checkInviteCode(code);
  if (!ok) return false;

  const normalized = String(code || '')
    .trim()
    .toUpperCase();
  if (envInviteCodes().includes(normalized)) return true;

  await db.none(
    `UPDATE infra_invite_codes SET uses_count = uses_count + 1 WHERE UPPER(code) = $1`,
    [normalized]
  );
  return true;
}

/** Password check only — does not issue a dashboard session. */
export async function loginMember(
  email: string,
  password: string
): Promise<MemberRow | null> {
  const row = await findMemberByEmail(email);
  if (!row?.password_hash) return null;
  const ok = await HashText.verifyHash(password, row.password_hash);
  if (!ok) return null;
  return row;
}

export async function checkEmail(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw new Error('Valid email required');
  }
  const existing = await findMemberByEmail(normalized);
  return {
    email: normalized,
    exists: Boolean(existing),
    action: existing ? ('login' as const) : ('signup' as const),
  };
}

export async function signupWithPassword(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  accountType?: string;
}) {
  const email = normalizeEmail(input.email);
  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  const accountType =
    String(input.accountType || 'business').toLowerCase() === 'individual'
      ? 'individual'
      : 'business';
  validatePassword(input.password);
  if (!firstName || !lastName) {
    throw new Error('First name and last name are required');
  }

  const existing = await findMemberByEmail(email);
  if (existing?.password_hash) {
    throw new Error('An account already exists for this email. Please log in.');
  }

  const passwordHash = await HashText.getHash(input.password);
  const name = `${firstName} ${lastName}`.trim();

  let member: MemberRow;
  if (existing) {
    member = await db.one<MemberRow>(
      `UPDATE infra_members
       SET password_hash = $1, name = $2, first_name = $3, last_name = $4, account_type = $5
       WHERE id = $6
       RETURNING ${MEMBER_SELECT}`,
      [passwordHash, name, firstName, lastName, accountType, existing.id]
    );
  } else {
    member = await db.one<MemberRow>(
      `INSERT INTO infra_members
         (org_id, email, password_hash, name, role, first_name, last_name, account_type)
       VALUES (NULL, $1, $2, $3, 'admin', $4, $5, $6)
       RETURNING ${MEMBER_SELECT}`,
      [email, passwordHash, name, firstName, lastName, accountType]
    );
  }

  const otp = await issueAndSendOtp(member.id, email, 'signup');
  return { ...otp, action: 'signup' as const, accountType };
}

/**
 * Verify password, then always send OTP. No dashboard JWT until OTP succeeds.
 */
export async function loginWithPassword(email: string, password: string) {
  const member = await loginMember(email, password);
  if (!member) {
    throw new Error('Invalid email or password');
  }
  const otp = await issueAndSendOtp(member.id, member.email, 'login');
  return { ...otp, action: 'login' as const };
}

/** @deprecated OTP-only start — prefer signup/login with password. */
export async function startEmailAuth(email: string) {
  const check = await checkEmail(email);
  if (!check.exists) {
    throw new Error('No account found. Please sign up with email and password.');
  }
  const member = await findMemberByEmail(check.email);
  if (!member) throw new Error('No account found');
  return issueAndSendOtp(member.id, check.email, 'login');
}

export async function verifyEmailOtp(
  email: string,
  otp: string,
  purposeHint?: string
) {
  const normalized = normalizeEmail(email);
  const code = String(otp || '').trim();
  if (!normalized || code.length < 4) {
    throw new Error('Email and OTP required');
  }

  const row = await db.oneOrNone<
    MemberRow & {
      otp_code: string | null;
      otp_expires_at: Date | null;
      otp_purpose: string | null;
    }
  >(
    `SELECT ${MEMBER_SELECT},
            otp_code, otp_expires_at, otp_purpose
     FROM infra_members WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [normalized]
  );

  if (!row || !row.otp_code || row.otp_code !== code) {
    throw new Error('Invalid verification code');
  }
  if (!row.otp_expires_at || row.otp_expires_at < new Date()) {
    throw new Error('Verification code expired');
  }

  const purpose = String(row.otp_purpose || purposeHint || 'login');

  await db.none(
    `UPDATE infra_members SET otp_code = NULL, otp_expires_at = NULL, otp_purpose = NULL WHERE id = $1`,
    [row.id]
  );

  if (purpose === 'password_reset') {
    return {
      email: row.email,
      purpose: 'password_reset' as const,
      resetToken: signResetToken(row.id, row.email),
    };
  }

  return sessionPayload(row);
}

export async function forgotPassword(email: string) {
  const check = await checkEmail(email);
  if (!check.exists) {
    // Don't reveal whether the email exists
    return {
      email: check.email,
      otpSent: true,
      requiresOtp: true,
      purpose: 'password_reset' as const,
    };
  }
  const member = await findMemberByEmail(check.email);
  if (!member) {
    return {
      email: check.email,
      otpSent: true,
      requiresOtp: true,
      purpose: 'password_reset' as const,
    };
  }
  return issueAndSendOtp(member.id, check.email, 'password_reset');
}

export async function resetPassword(input: {
  email: string;
  password: string;
  resetToken: string;
}) {
  validatePassword(input.password);
  const decoded = decodeResetToken(input.resetToken);
  if (!decoded) {
    throw new Error('Invalid or expired reset token. Request a new code.');
  }
  const email = normalizeEmail(input.email);
  if (email !== normalizeEmail(decoded.email)) {
    throw new Error('Email does not match reset token');
  }

  const passwordHash = await HashText.getHash(input.password);
  await db.none(
    `UPDATE infra_members SET password_hash = $1, otp_code = NULL, otp_expires_at = NULL, otp_purpose = NULL
     WHERE id = $2`,
    [passwordHash, decoded.memberId]
  );

  return { email, reset: true };
}

export async function googleAuth(
  authToken: string,
  opts?: { accountType?: string }
) {
  const token = String(authToken || '').trim();
  if (!token) throw new Error('Google token required');

  const profile = await verifyGoogleAuthToken(token);

  if (!profile.email) {
    throw new Error('Google account email is required');
  }

  const email = normalizeEmail(profile.email);
  const accountType =
    String(opts?.accountType || 'business').toLowerCase() === 'individual'
      ? 'individual'
      : 'business';
  let member = await findMemberByEmail(email);

  if (!member && profile.sub) {
    member = await db.oneOrNone<MemberRow>(
      `SELECT ${MEMBER_SELECT}
       FROM infra_members WHERE google_sub = $1 LIMIT 1`,
      [profile.sub]
    );
  }

  if (!member) {
    member = await db.one<MemberRow>(
      `INSERT INTO infra_members (org_id, email, password_hash, name, role, google_sub, first_name, last_name, account_type)
       VALUES (NULL, $1, NULL, $2, 'admin', $3, $4, $5, $6)
       RETURNING ${MEMBER_SELECT}`,
      [
        email,
        profile.name || email.split('@')[0],
        profile.sub,
        profile.given_name || null,
        profile.family_name || null,
        accountType,
      ]
    );
  } else if (profile.sub && !member.google_sub) {
    await db.none(`UPDATE infra_members SET google_sub = $1 WHERE id = $2`, [
      profile.sub,
      member.id,
    ]);
    member.google_sub = profile.sub;
  }

  // Always OTP after Google as well — before dashboard access
  const otp = await issueAndSendOtp(member.id, email, 'google');
  return { ...otp, action: member.org_id ? ('login' as const) : ('signup' as const) };
}

export async function createOrganization(memberId: string, name: string) {
  const legalName = String(name || '').trim();
  if (legalName.length < 2) {
    throw new Error('Legal business name is required');
  }

  const member = await db.oneOrNone<MemberRow>(
    `SELECT ${MEMBER_SELECT}
     FROM infra_members WHERE id = $1`,
    [memberId]
  );
  if (!member) throw new Error('Member not found');
  if (member.org_id) throw new Error('Organization already exists for this account');

  let slug = slugify(legalName);
  const clash = await db.oneOrNone(`SELECT id FROM infra_organizations WHERE slug = $1`, [slug]);
  if (clash) {
    slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  }

  const org = await db.one<{ id: string; name: string; verification_status: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id, name, verification_status`,
    [legalName, slug]
  );

  await db.none(`UPDATE infra_members SET org_id = $1, role = 'admin' WHERE id = $2`, [
    org.id,
    memberId,
  ]);

  // Phase 1: every org gets a TEST/USDC wallet. LIVE is provisioned lazily after KYC.
  await bootstrapOrgWallets(org.id);

  const updated = { ...member, org_id: org.id, role: 'admin' };
  return sessionPayload(updated);
}

export async function getMemberProfile(memberId: string) {
  const row = await db.oneOrNone<MemberRow & { org: string | null; verificationStatus: string | null }>(
    `SELECT m.id, m.org_id, m.email, m.name, m.role, m.password_hash, m.google_sub,
            m.first_name, m.last_name, m.account_type, m.dayfi_tag, m.phone, m.date_of_birth,
            m.country, m.address, m.bvn, m.kyc_level, m.personal_onboarding_complete,
            o.name AS org, o.verification_status AS "verificationStatus"
     FROM infra_members m
     LEFT JOIN infra_organizations o ON o.id = m.org_id
     WHERE m.id = $1`,
    [memberId]
  );
  if (!row) return null;
  const needs = accountNeeds(row);
  const displayName =
    row.name ||
    [row.first_name, row.last_name].filter(Boolean).join(' ') ||
    row.email.split('@')[0];
  return {
    email: row.email,
    name: displayName,
    role: row.role,
    orgId: row.org_id,
    org: row.org,
    verificationStatus: row.verificationStatus,
    accountType: needs.accountType,
    dayfiTag: needs.dayfiTag,
    kycLevel: needs.kycLevel,
    needsPersonalSetup: needs.needsPersonalSetup,
    needsOrgSetup: needs.needsOrgSetup,
    phone: row.phone || null,
    country: row.country || null,
    bvnSet: Boolean(row.bvn),
  };
}

/**
 * Individual onboarding — mirrors mobile complete_personal_information + BVN for Tier 2.
 * Creates a personal workspace org so Collect/Send APIs keep working.
 */
export async function completePersonalOnboarding(
  memberId: string,
  input: {
    dayfiTag: string;
    phone?: string;
    dateOfBirth?: string;
    country?: string;
    address?: string;
    bvn?: string;
  }
) {
  const member = await db.oneOrNone<MemberRow>(
    `SELECT ${MEMBER_SELECT} FROM infra_members WHERE id = $1`,
    [memberId]
  );
  if (!member) throw new Error('Member not found');
  if (String(member.account_type || '') !== 'individual') {
    throw new Error('Personal onboarding is only for individual accounts');
  }

  const tag = normalizeDayfiTag(input.dayfiTag);
  validateDayfiTag(tag);

  const clash = await db.oneOrNone(
    `SELECT id FROM infra_members WHERE LOWER(dayfi_tag) = LOWER($1) AND id <> $2`,
    [tag, memberId]
  );
  if (clash) throw new Error('That Dayfi tag is already taken');

  const bvn = String(input.bvn || '').replace(/\D/g, '');
  if (!bvn || bvn.length !== 11) {
    throw new Error('BVN is required (11 digits) to start using Dayfi as an individual');
  }

  const kycLevel = 2;
  const display =
    member.name ||
    [member.first_name, member.last_name].filter(Boolean).join(' ') ||
    tag;

  await db.none(
    `UPDATE infra_members SET
       dayfi_tag = $1,
       phone = $2,
       date_of_birth = $3,
       country = $4,
       address = $5,
       bvn = $6,
       kyc_level = $7,
       personal_onboarding_complete = TRUE,
       account_type = 'individual'
     WHERE id = $8`,
    [
      tag,
      String(input.phone || '').trim() || null,
      input.dateOfBirth || null,
      String(input.country || 'NG').toUpperCase() || 'NG',
      String(input.address || '').trim() || null,
      bvn || null,
      kycLevel,
      memberId,
    ]
  );

  let orgId = member.org_id;
  if (!orgId) {
    let slug = slugify(tag);
    const orgClash = await db.oneOrNone(`SELECT id FROM infra_organizations WHERE slug = $1`, [
      slug,
    ]);
    if (orgClash) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;

    const org = await db.one<{ id: string }>(
      `INSERT INTO infra_organizations (name, slug, verification_status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`${display}`, slug, bvn ? 'pending' : 'unverified']
    );
    orgId = org.id;
    await db.none(`UPDATE infra_members SET org_id = $1, role = 'admin' WHERE id = $2`, [
      orgId,
      memberId,
    ]);
    await bootstrapOrgWallets(orgId);
  }

  const updated = await db.one<MemberRow>(
    `SELECT ${MEMBER_SELECT} FROM infra_members WHERE id = $1`,
    [memberId]
  );
  return sessionPayload(updated);
}

/** Claim / update Dayfi tag for business or individual (after onboarding). */
export async function setDayfiTag(memberId: string, rawTag: string) {
  const tag = normalizeDayfiTag(rawTag);
  validateDayfiTag(tag);
  const clash = await db.oneOrNone(
    `SELECT id FROM infra_members WHERE LOWER(dayfi_tag) = LOWER($1) AND id <> $2`,
    [tag, memberId]
  );
  if (clash) throw new Error('That Dayfi tag is already taken');
  await db.none(`UPDATE infra_members SET dayfi_tag = $1 WHERE id = $2`, [tag, memberId]);
  const updated = await db.one<MemberRow>(
    `SELECT ${MEMBER_SELECT} FROM infra_members WHERE id = $1`,
    [memberId]
  );
  return sessionPayload(updated);
}

export async function lookupDayfiTag(rawTag: string) {
  const tag = normalizeDayfiTag(rawTag);
  if (!tag) throw new Error('Dayfi tag required');
  const row = await db.oneOrNone<{
    dayfi_tag: string;
    name: string | null;
    account_type: string | null;
  }>(
    `SELECT dayfi_tag, name, account_type FROM infra_members
     WHERE LOWER(dayfi_tag) = LOWER($1) LIMIT 1`,
    [tag]
  );
  if (!row) throw new Error('No Dayfi user found with that tag');
  return {
    dayfiTag: row.dayfi_tag,
    name: row.name,
    accountType: row.account_type === 'individual' ? 'individual' : 'business',
  };
}

export async function infraAuthMiddleware(
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

  try {
    if (isApiKeySecret(token)) {
      const keyAuth = await authenticateApiKey(token);
      if (!keyAuth) {
        errorResponse(res, 'Invalid or revoked API key', 401);
        return;
      }
      req.infra = keyAuth.infra;
      req.infraEnv = keyAuth.env;
      next();
      return;
    }

    req.infraEnv = envFromHeader(req);
    const auth = decodeInfraToken(token);
    if (!auth) {
      errorResponse(res, 'Invalid or expired token', 401);
      return;
    }
    req.infra = auth;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireOrgMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.infra?.orgId) {
    errorResponse(res, 'Organization setup required', 403);
    return;
  }
  next();
}

export async function requireVerifiedForLiveMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.infraEnv !== 'live') {
    next();
    return;
  }
  const orgId = req.infra?.orgId;
  if (!orgId) {
    errorResponse(res, 'Organization setup required', 403);
    return;
  }
  const org = await db.oneOrNone<{ verification_status: string }>(
    `SELECT verification_status FROM infra_organizations WHERE id = $1`,
    [orgId]
  );
  if (org?.verification_status !== 'verified') {
    errorResponse(
      res,
      'KYC verification required before using LIVE. Complete verification under Organization.',
      403
    );
    return;
  }
  next();
}

export async function listApiKeys(orgId: string, env: 'test' | 'live') {
  return db.any(
    `SELECT k.id, k.name, k.prefix, k.last_four AS "lastFour", k.created_at AS "createdAt",
            k.last_used_at AS "lastUsedAt", m.email AS "createdBy"
     FROM infra_api_keys k
     LEFT JOIN infra_members m ON m.id = k.created_by
     WHERE k.org_id = $1 AND k.environment = $2 AND k.revoked_at IS NULL
     ORDER BY k.created_at DESC`,
    [orgId, env]
  );
}

export async function createApiKey(
  orgId: string,
  env: 'test' | 'live',
  name: string,
  actor: InfraAuth
) {
  const { secret, prefix, lastFour } = generateApiSecret(env);
  const keyHash = hashApiKey(secret);
  const row = await db.one<{ id: string; created_at: Date }>(
    `INSERT INTO infra_api_keys (org_id, environment, name, key_hash, prefix, last_four, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [orgId, env, name, keyHash, prefix, lastFour, actor.memberId]
  );

  await db.none(
    `INSERT INTO infra_api_key_audit (org_id, key_id, action, actor_email)
     VALUES ($1, $2, 'key.created', $3)`,
    [orgId, row.id, actor.email]
  );

  return {
    id: row.id,
    name,
    prefix,
    lastFour,
    secret,
    createdAt: row.created_at,
    createdBy: actor.email,
  };
}

export async function rotateApiKey(
  orgId: string,
  env: 'test' | 'live',
  keyId: string,
  actor: InfraAuth
) {
  const existing = await db.oneOrNone<{ id: string }>(
    `SELECT id FROM infra_api_keys
     WHERE id = $1 AND org_id = $2 AND environment = $3 AND revoked_at IS NULL`,
    [keyId, orgId, env]
  );
  if (!existing) return null;

  await db.none(`UPDATE infra_api_keys SET revoked_at = NOW() WHERE id = $1`, [keyId]);

  const created = await createApiKey(orgId, env, 'Rotated key', actor);
  await db.none(
    `INSERT INTO infra_api_key_audit (org_id, key_id, action, actor_email)
     VALUES ($1, $2, 'key.rotated', $3)`,
    [orgId, keyId, actor.email]
  );
  return created;
}

export async function listKeyAudit(orgId: string) {
  return db.any(
    `SELECT id, action, key_id AS "keyId", actor_email AS actor, created_at AS at
     FROM infra_api_key_audit
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [orgId]
  );
}

export async function getOverview(orgId: string, env: 'test' | 'live') {
  const rows = await db.any<{
    amount: string;
    fee: string;
    currency: string | null;
    status: string;
  }>(
    `SELECT amount::text AS amount, COALESCE(fee, 0)::text AS fee, currency, status
     FROM infra_transactions
     WHERE org_id = $1 AND environment = $2`,
    [orgId, env]
  );

  /** Stablecoins map to fiat ledger currency — same as mobile (USDC → USD). */
  function ledgerCurrency(raw: string | null | undefined): string {
    const c = String(raw || 'NGN').trim().toUpperCase();
    if (c === 'USDC' || c === 'USDT') return 'USD';
    if (c === 'EURC') return 'EUR';
    return c || 'NGN';
  }

  async function toUsd(amount: number, currency: string): Promise<number | null> {
    if (!Number.isFinite(amount) || amount === 0) return 0;
    const ledger = ledgerCurrency(currency);
    if (ledger === 'USD') return amount;
    try {
      const { usdAmount } = await convertAmountToUsd(amount, ledger);
      return usdAmount;
    } catch {
      return null;
    }
  }

  let volumeUsd = 0;
  let pendingUsd = 0;
  let feesUsd = 0;
  let settledUsd = 0;
  let successCount = 0;
  const byCurrency: Record<string, number> = {};

  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    const fee = Number(row.fee) || 0;
    const rawCur = String(row.currency || 'NGN').toUpperCase();
    byCurrency[rawCur] = (byCurrency[rawCur] || 0) + amount;

    const usd = await toUsd(amount, rawCur);
    if (usd == null) continue;

    volumeUsd += usd;
    const feeAsUsd = fee > 0 ? (await toUsd(fee, rawCur)) ?? 0 : 0;
    feesUsd += feeAsUsd;

    const status = String(row.status || '').toLowerCase();
    if (status === 'pending' || status === 'processing') {
      pendingUsd += usd;
    }
    if (status === 'settled' || status === 'completed' || status === 'success') {
      settledUsd += usd;
      successCount += 1;
    }
  }

  const total = rows.length;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  let ngnPerUsd: number | null = null;
  try {
    ngnPerUsd = await resolveExchangeRate('USD', 'NGN');
  } catch {
    ngnPerUsd = null;
  }

  const volume = round2(volumeUsd);
  const pending = round2(pendingUsd);
  const fees = round2(feesUsd);

  return {
    // Mobile-style: USD ledger totals (USDC counts as USD 1:1)
    volume,
    pending,
    fees,
    settled: round2(settledUsd),
    currency: 'USD',
    // Optional NGN view via platform rate — never treat USDC face as ₦
    volumeNgn: ngnPerUsd != null ? Math.round(volume * ngnPerUsd) : null,
    pendingNgn: ngnPerUsd != null ? Math.round(pending * ngnPerUsd) : null,
    feesNgn: ngnPerUsd != null ? Math.round(fees * ngnPerUsd) : null,
    rate:
      ngnPerUsd != null
        ? {
            from: 'USD',
            to: 'NGN',
            ngnPerUsd,
            label: `$1 = ₦${Number(ngnPerUsd).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}`,
          }
        : null,
    byCurrency,
    changePct: null,
    successfulPct: total === 0 ? null : Math.round((successCount / total) * 1000) / 10,
    failed: 0,
    transactionCount: total,
  };
}

export async function getTransactions(
  orgId: string,
  env: 'test' | 'live',
  direction?: string
) {
  const params: unknown[] = [orgId, env];
  let sql = `SELECT id::text AS id, amount, currency, country, status, method, direction,
                    fee, external_id AS "externalId", metadata, created_at AS "createdAt"
             FROM infra_transactions
             WHERE org_id = $1 AND environment = $2`;
  if (direction === 'payment' || direction === 'payout' || direction === 'deposit' || direction === 'internal_transfer') {
    params.push(direction);
    sql += ` AND direction = $3`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 100`;
  return db.any(sql, params);
}

export async function getReconciliation(orgId: string, env: 'test' | 'live') {
  // Phase 6: observe provider + ledger + settlement (no money movement).
  const { getReconciliationOverview } = await import('./infraReconciliationService');
  return getReconciliationOverview(orgId, env);
}

export async function getSettlements(orgId: string, env: 'test' | 'live') {
  return db.any(
    `SELECT id::text AS id, amount, currency, status, method, created_at AS "createdAt"
     FROM infra_transactions
     WHERE org_id = $1 AND environment = $2 AND direction = 'settlement'
     ORDER BY created_at DESC
     LIMIT 100`,
    [orgId, env]
  );
}

export { success, errorResponse };
