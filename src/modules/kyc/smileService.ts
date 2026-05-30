import crypto from 'node:crypto';
import axios from 'axios';
import config from '../../config/env';
import AuthService from '../authentication/services';
import PaymentService from '../payment/services';

const SUCCESS_RESULT_CODES = new Set([
  '0810',
  '0811',
  '0817',
  '0820',
  '0840',
  '0823',
  '1012',
  '1021',
  '1020',
  '0814',
  '0816',
  '0824',
  '1214',
  '1213',
  '1212',
  '8214',
  '8084',
  '0803',
  '0802',
  '1240',
]);

export type ParsedSmileKyc = {
  userId: string;
  verified: boolean;
  idType?: string;
  idNumber?: string;
  bvn?: string;
  nin?: string;
  resultCode?: string;
  resultText?: string;
};

function partnerId(): string {
  const id = String(config?.SMILE_PARTNER_ID || '').trim();
  if (!id) throw new Error('Smile partner ID is not configured');
  return id;
}

function apiKey(): string {
  const key = String(config?.SMILE_API_KEY || '').trim();
  if (!key) throw new Error('Smile API key is not configured');
  return key;
}

function baseUrl(): string {
  const url = String(config?.SMILE_BASE_URL || 'https://api.smileidentity.com').trim();
  return url.replace(/\/+$/, '');
}

function generateSignature(timestamp: string): string {
  return crypto
    .createHmac('sha256', apiKey())
    .update(`${partnerId()}:${timestamp}`)
    .digest('base64');
}

/** Smile v2 REST headers (block-user, etc.). */
function generateV2RequestSignature(timestamp: string): string {
  return crypto
    .createHmac('sha256', apiKey())
    .update(`${timestamp}${partnerId()}sid_request`)
    .digest('base64');
}

/** Allow an existing Smile user_id to submit a new Biometric KYC enrollment job. */
export async function allowSmileReEnroll(userId: string): Promise<void> {
  const trimmed = userId.trim();
  if (!trimmed) return;

  const timestamp = new Date().toISOString();
  const signature = generateV2RequestSignature(timestamp);

  await axios.post(
    `${baseUrl()}/v2/block-user`,
    {
      allow_new_enroll: true,
      user_id: trimmed,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'smileid-partner-id': partnerId(),
        'smileid-timestamp': timestamp,
        'smileid-request-signature': signature,
      },
    }
  );
}

function isVerifiedPayload(payload: Record<string, unknown>): boolean {
  const code = String(payload.ResultCode ?? payload.resultCode ?? '').trim();
  if (code && SUCCESS_RESULT_CODES.has(code)) return true;

  const actions = payload.Actions as Record<string, string> | undefined;
  if (actions) {
    const verify = String(
      actions.Verify_ID_Number ?? actions.verify_id_number ?? ''
    ).toLowerCase();
    if (verify === 'verified') return true;
  }

  const text = String(payload.ResultText ?? payload.resultText ?? '').toLowerCase();
  return text.includes('approved') || text.includes('verified');
}

function partnerUserId(payload: Record<string, unknown>): string {
  const direct = String(payload.user_id ?? payload.userId ?? '').trim();
  if (direct) return direct;

  const params =
    (payload.PartnerParams as Record<string, unknown> | undefined) ??
    (payload.partner_params as Record<string, unknown> | undefined) ??
    {};
  return String(params.user_id ?? params.userId ?? '').trim();
}

/** Flutter Biometric KYC onSuccess — file paths only, not Smile verification JSON. */
export function isBiometricSdkCapturePayload(raw: unknown): boolean {
  let payload: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return false;
    }
  } else if (raw && typeof raw === 'object') {
    payload = raw as Record<string, unknown>;
  } else {
    return false;
  }
  return (
    typeof payload.selfieFile === 'string' ||
    payload.didSubmitBiometricKycJob !== undefined ||
    Array.isArray(payload.livenessFiles)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll Smile job_status after mobile Biometric KYC capture. */
export async function fetchSmileJobStatus(
  userId: string,
  jobId: string
): Promise<Record<string, unknown>> {
  const timestamp = new Date().toISOString();
  const signature = generateSignature(timestamp);

  const response = await axios.post(
    `${baseUrl()}/v1/job_status`,
    {
      partner_id: partnerId(),
      timestamp,
      signature,
      user_id: userId,
      job_id: jobId,
      image_links: false,
      history: false,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  return response.data as Record<string, unknown>;
}

export async function resolveBiometricKycFromJob(
  userId: string,
  jobId: string,
  idTypeHint = 'BVN',
  maxAttempts = 6,
  delayMs = 2000
): Promise<ParsedSmileKyc | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await fetchSmileJobStatus(userId, jobId);
    const resultBlock = status.result as Record<string, unknown> | undefined;

    const parsed =
      parseSmileKycPayload(status, idTypeHint, userId) ??
      (resultBlock
        ? parseSmileKycPayload(resultBlock, idTypeHint, userId)
        : null) ??
      parseSmileKycPayload(
        {
          ...status,
          ...(resultBlock ?? {}),
          PartnerParams: {
            user_id: userId,
            job_id: jobId,
            ...(resultBlock?.PartnerParams as Record<string, unknown> | undefined),
          },
        },
        idTypeHint,
        userId
      );

    if (parsed?.verified) {
      return { ...parsed, userId };
    }

    const complete = status.job_complete === true || status.job_complete === 'true';
    const success = status.job_success === true || status.job_success === 'true';
    if (complete && !success) {
      const text = String(
        (resultBlock?.ResultText as string | undefined) ??
          status.ResultText ??
          'BVN verification was not approved'
      );
      throw new Error(text);
    }

    if (attempt < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }

  return null;
}

function extractIdNumber(
  payload: Record<string, unknown>,
  idTypeHint?: string
): { idType?: string; idNumber?: string } {
  const idInfo =
    (payload.IDInfo as Record<string, unknown> | undefined) ??
    (payload.id_info as Record<string, unknown> | undefined);

  const fullData =
    (payload.FullData as Record<string, unknown> | undefined) ??
    (payload.full_data as Record<string, unknown> | undefined);

  const kycReceipt =
    (payload.KYCReceipt as Record<string, unknown> | undefined) ??
    (payload.kyc_receipt as Record<string, unknown> | undefined);

  const idType = String(
    idInfo?.id_type ?? idInfo?.IDType ?? idTypeHint ?? ''
  ).toUpperCase();
  const idNumber = String(
    idInfo?.id_number ??
      idInfo?.IDNumber ??
      fullData?.bvn ??
      fullData?.nin ??
      kycReceipt?.IDNumber ??
      ''
  ).trim();

  return { idType: idType || undefined, idNumber: idNumber || undefined };
}

export function parseSmileKycPayload(
  raw: unknown,
  idTypeHint?: string,
  userIdOverride?: string
): ParsedSmileKyc | null {
  let payload: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    payload = raw as Record<string, unknown>;
  } else {
    return null;
  }

  if (isBiometricSdkCapturePayload(payload)) {
    return null;
  }

  const nested =
    (payload.result as Record<string, unknown> | undefined) ??
    (payload.data as Record<string, unknown> | undefined);
  if (nested && typeof nested === 'object') {
    payload = { ...payload, ...nested };
  }

  const userId = userIdOverride?.trim() || partnerUserId(payload);
  if (!userId) return null;

  const verified = isVerifiedPayload(payload);
  const { idType, idNumber } = extractIdNumber(payload, idTypeHint);

  const normalizedType = (idType ?? idTypeHint ?? '').toUpperCase();
  const bvn =
    normalizedType === 'BVN' && idNumber
      ? idNumber
      : String(fullDataField(payload, 'bvn') ?? '').trim() || undefined;
  const nin =
    normalizedType.includes('NIN') && idNumber
      ? idNumber
      : String(fullDataField(payload, 'nin') ?? '').trim() || undefined;

  return {
    userId,
    verified,
    idType: idType ?? idTypeHint,
    idNumber,
    bvn,
    nin,
    resultCode: String(payload.ResultCode ?? payload.resultCode ?? ''),
    resultText: String(payload.ResultText ?? payload.resultText ?? ''),
  };
}

function fullDataField(
  payload: Record<string, unknown>,
  key: string
): string | undefined {
  const full =
    (payload.FullData as Record<string, unknown> | undefined) ??
    (payload.full_data as Record<string, unknown> | undefined);
  const val = full?.[key];
  return val != null ? String(val) : undefined;
}

/** Synchronous Enhanced KYC (NIN) from backend. */
export async function verifyIdWithSmile(params: {
  userId: string;
  idType: string;
  idNumber: string;
  firstName: string;
  lastName: string;
  dob?: string;
}): Promise<ParsedSmileKyc> {
  const timestamp = new Date().toISOString();
  const signature = generateSignature(timestamp);
  const idType = params.idType.toUpperCase();
  const idNumber = String(params.idNumber).trim();

  const response = await axios.post(
    `${baseUrl()}/v1/id_verification`,
    {
      partner_id: partnerId(),
      timestamp,
      signature,
      country: 'NG',
      id_type: idType,
      id_number: idNumber,
      first_name: params.firstName,
      last_name: params.lastName,
      ...(params.dob ? { dob: params.dob } : {}),
      partner_params: {
        user_id: params.userId,
        job_id: `dayfi-${idType.toLowerCase()}-${Date.now()}`,
        job_type: 5,
      },
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const body = response.data as Record<string, unknown>;
  const parsed =
    parseSmileKycPayload(body, idType) ??
    parseSmileKycPayload(
      { ...body, PartnerParams: { user_id: params.userId } },
      idType
    );

  if (!parsed) {
    throw new Error('Could not parse Smile ID response');
  }
  if (!parsed.verified) {
    throw new Error(
      parsed.resultText || 'Identity could not be verified with Smile ID'
    );
  }

  return {
    ...parsed,
    userId: params.userId,
    idType,
    idNumber,
    nin: idType.includes('NIN') ? idNumber : parsed.nin,
    bvn: idType === 'BVN' ? idNumber : parsed.bvn,
  };
}

const authService = new AuthService();
const paymentService = new PaymentService();

export type KycProfileSnapshot = {
  level: string;
  tierLevel: number;
  bvn?: string;
  idType?: string;
  idNumber?: string;
  bvnVerified: boolean;
  ninVerified: boolean;
  canSendMoney: boolean;
  /** Next step for mobile routing: tier2 = BVN + selfie, tier3 = NIN, none = complete */
  nextVerificationStep: 'tier2' | 'tier3' | 'none';
  ngnAccount?: { accountNumber?: string; bankName?: string };
};

export function parseTierLevel(level: string): number {
  const raw = String(level || '').toLowerCase();
  if (raw.startsWith('level-')) {
    const n = Number.parseInt(raw.slice(6), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, 3);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 3);
}

function resolveNextVerificationStep(
  tierLevel: number,
  bvnVerified: boolean,
  ninVerified: boolean
): 'tier2' | 'tier3' | 'none' {
  if (tierLevel < 2 || !bvnVerified) return 'tier2';
  if (tierLevel < 3 || !ninVerified) return 'tier3';
  return 'none';
}

export async function buildKycProfileSnapshot(
  userId: string,
  ngnAccount?: { accountNumber?: string; bankName?: string }
): Promise<KycProfileSnapshot> {
  const profile = await authService.getUserById(userId);
  const level = String(profile?.level ?? 'level-1');
  const bvn = String(profile?.bvn ?? '').trim();
  const idType = String(profile?.id_type ?? profile?.idType ?? '').trim();
  const idNumber = String(profile?.id_number ?? profile?.idNumber ?? '').trim();
  const bvnVerified = /^\d{11}$/.test(bvn);
  const ninVerified =
    idType.toUpperCase().includes('NIN') && /^\d{11}$/.test(idNumber);
  const tierLevel = parseTierLevel(level);

  return {
    level,
    tierLevel,
    bvn: bvnVerified ? bvn : undefined,
    idType: idType || undefined,
    idNumber: idNumber || undefined,
    bvnVerified,
    ninVerified,
    canSendMoney: tierLevel >= 2 && bvnVerified,
    nextVerificationStep: resolveNextVerificationStep(
      tierLevel,
      bvnVerified,
      ninVerified
    ),
    ngnAccount,
  };
}

/** Smile Enhanced KYC for BVN; falls back to Flutterwave lookup + save when Smile fails. */
export async function verifyBvnForUser(params: {
  userId: string;
  bvn: string;
  firstName: string;
  lastName: string;
  dob?: string;
}): Promise<ParsedSmileKyc> {
  const bvn = String(params.bvn).trim();
  if (!/^\d{11}$/.test(bvn)) {
    throw new Error('BVN must be exactly 11 digits');
  }

  try {
    return await verifyIdWithSmile({
      userId: params.userId,
      idType: 'BVN',
      idNumber: bvn,
      firstName: params.firstName,
      lastName: params.lastName,
      dob: params.dob,
    });
  } catch (smileErr: unknown) {
    console.warn(
      `[verifyBvnForUser] Smile BVN failed, using Flutterwave fallback: ${
        smileErr instanceof Error ? smileErr.message : String(smileErr)
      }`
    );
    await authService.initiateBvnLookup(bvn, params.firstName, params.lastName);
    return {
      userId: params.userId,
      verified: true,
      bvn,
      idType: 'BVN',
      idNumber: bvn,
    };
  }
}

export async function applySmileKycToUser(params: {
  userId: string;
  bvn?: string;
  nin?: string;
}): Promise<KycProfileSnapshot> {
  const userId = params.userId;
  const bvn = params.bvn?.trim();
  const nin = params.nin?.trim();

  if (bvn && /^\d{11}$/.test(bvn)) {
    await authService.saveUserBvn(userId, bvn);
    await authService.updateUserLevel('level-2', userId);
  }

  if (nin && /^\d{11}$/.test(nin)) {
    const existing = await authService.getUserById(userId);
    const storedBvn = String(existing?.bvn ?? bvn ?? '').trim();
    if (!/^\d{11}$/.test(storedBvn)) {
      throw new Error(
        'Complete Tier 2 verification (BVN + selfie) before verifying your NIN.'
      );
    }

    const user = existing ?? (await authService.getUserById(userId));
    const snakeUser = {
      gender: user?.gender ?? '',
      dateOfBirth: user?.date_of_birth ?? user?.dateOfBirth ?? '',
      userId,
      country: user?.country ?? 'NG',
      state: user?.state ?? '',
      street: user?.street ?? '',
      city: user?.city ?? '',
      postalCode: user?.postal_code ?? user?.postalCode ?? '',
      address: user?.address ?? '',
      phoneNumber: user?.phone_number ?? user?.phoneNumber ?? '',
      idType: 'NIN_V2',
      idNumber: nin,
    };
    await authService.updateUserProfile(snakeUser as any);
    await authService.updateUserLevel('level-3', userId);
  }

  let ngnAccount: { accountNumber?: string; bankName?: string } | undefined;
  const profile = await authService.getUserById(userId);
  const email = String(profile?.email ?? '').trim();
  const storedBvn = String(profile?.bvn ?? bvn ?? '').trim();
  const tierLevel = parseTierLevel(String(profile?.level ?? ''));

  if (email && storedBvn && tierLevel >= 2) {
    try {
      const wallet = await paymentService.ensureNgnVirtualAccount(
        userId,
        email,
        storedBvn
      );
      ngnAccount = {
        accountNumber: (wallet as { account_number?: string }).account_number,
        bankName: (wallet as { bank_name?: string }).bank_name,
      };
    } catch (err: unknown) {
      console.warn(
        `[applySmileKycToUser] NGN VA provision skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return buildKycProfileSnapshot(userId, ngnAccount);
}

export async function mergeAndApplySmileResult(
  parsed: ParsedSmileKyc
): Promise<KycProfileSnapshot> {
  const user = await authService.getUserById(parsed.userId);
  let bvn = parsed.bvn;
  let nin = parsed.nin;

  if (!bvn && parsed.idType?.toUpperCase() === 'BVN' && parsed.idNumber) {
    bvn = parsed.idNumber;
  }
  if (
    !nin &&
    parsed.idType?.toUpperCase().includes('NIN') &&
    parsed.idNumber
  ) {
    nin = parsed.idNumber;
  }

  if (!bvn && user?.bvn) bvn = String(user.bvn);
  if (!nin && user?.id_type?.toUpperCase().includes('NIN')) {
    nin = String(user.id_number ?? '');
  }

  return applySmileKycToUser({ userId: parsed.userId, bvn, nin });
}

export function smileCallbackUrl(): string {
  const configured = String(config?.SMILE_CALLBACK_URL || '').trim();
  if (configured) return configured;
  const appUrl = String(process.env.DAYFI_APP_URL || '').trim();
  if (appUrl) {
    return `${appUrl.replace(/\/+$/, '')}/api/v1/kyc/smile/webhook`;
  }
  return '';
}
