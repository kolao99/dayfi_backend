import crypto from 'crypto';

export type WhatsappSecurePurpose = 'setup' | 'kyc' | 'authorize';

type TokenPayload = {
  u: string;
  p: WhatsappSecurePurpose;
  i?: string;
  e: number;
};

function signingSecret(): string {
  return (
    String(process.env.FOUR_WHATSAPP_SECURE_TOKEN_SECRET || '').trim() ||
    String(process.env.WALLET_ENCRYPTION_KEY || '').trim() ||
    String(process.env.META_WHATSAPP_VERIFY_TOKEN || '').trim()
  );
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function signPayload(encodedPayload: string): string {
  const secret = signingSecret();
  if (!secret) {
    throw new Error('FOUR whatsapp secure token secret is not configured.');
  }
  return base64UrlEncode(
    crypto.createHmac('sha256', secret).update(encodedPayload).digest()
  );
}

export function createWhatsappSecureToken(input: {
  userId: string;
  purpose: WhatsappSecurePurpose;
  intentId?: string;
  ttlSeconds?: number;
}): string {
  const payload: TokenPayload = {
    u: String(input.userId),
    p: input.purpose,
    e: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 3600),
  };
  if (input.intentId) payload.i = String(input.intentId);

  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signPayload(encoded)}`;
}

export function verifyWhatsappSecureToken(
  token: string,
  expectedPurpose?: WhatsappSecurePurpose
):
  | { ok: true; userId: string; purpose: WhatsappSecurePurpose; intentId?: string }
  | { ok: false; reason: string } {
  const raw = String(token || '').trim();
  if (!raw.includes('.')) {
    return { ok: false, reason: 'not_whatsapp_secure_token' };
  }

  const [encoded, signature] = raw.split('.', 2);
  if (!encoded || !signature) {
    return { ok: false, reason: 'malformed_token' };
  }

  let expectedSig: string;
  try {
    expectedSig = signPayload(encoded);
  } catch {
    return { ok: false, reason: 'secret_missing' };
  }

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSig)
    );
    if (!valid) return { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }

  if (!payload.u || !payload.p || !payload.e) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (payload.e < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  if (expectedPurpose && payload.p !== expectedPurpose) {
    return { ok: false, reason: 'purpose_mismatch' };
  }

  return {
    ok: true,
    userId: payload.u,
    purpose: payload.p,
    intentId: payload.i,
  };
}
