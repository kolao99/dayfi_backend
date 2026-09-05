import crypto from 'crypto';

type FlowTokenPayload = {
  u: string;
  p: 'pin_setup' | 'pin_auth' | 'bill';
  /** Bill category when p === 'bill' */
  c?: string;
  e: number;
};

function signingSecret(): string {
  return (
    String(process.env.FOUR_WHATSAPP_SECURE_TOKEN_SECRET || '').trim() ||
    String(process.env.WALLET_ENCRYPTION_KEY || '').trim() ||
    String(process.env.META_WHATSAPP_VERIFY_TOKEN || '').trim()
  );
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad =
    padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

export function createWhatsappFlowToken(input: {
  userId: string;
  purpose?: 'pin_setup' | 'pin_auth' | 'bill';
  category?: string;
  ttlSeconds?: number;
}): string {
  const payload: FlowTokenPayload = {
    u: input.userId,
    p: input.purpose ?? 'pin_setup',
    e: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 3600),
  };
  if (input.purpose === 'bill' && input.category) {
    payload.c = String(input.category).toUpperCase();
  }
  const encoded = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac('sha256', signingSecret()).update(encoded).digest()
  );
  return `${encoded}.${sig}`;
}

export function verifyWhatsappFlowToken(
  token: string
):
  | {
      ok: true;
      userId: string;
      purpose: 'pin_setup' | 'pin_auth' | 'bill';
      category?: string;
    }
  | { ok: false; reason: string } {
  const raw = String(token || '').trim();
  const [encoded, signature] = raw.split('.', 2);
  if (!encoded || !signature) return { ok: false, reason: 'malformed' };

  const expected = b64url(
    crypto.createHmac('sha256', signingSecret()).update(encoded).digest()
  );
  try {
    if (
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return { ok: false, reason: 'bad_signature' };
    }
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  try {
    const payload = JSON.parse(
      b64urlDecode(encoded).toString('utf8')
    ) as FlowTokenPayload;
    if (!payload.u || !payload.e || payload.e < Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: 'expired_or_invalid' };
    }
    if (
      payload.p !== 'pin_setup' &&
      payload.p !== 'pin_auth' &&
      payload.p !== 'bill'
    ) {
      return { ok: false, reason: 'bad_purpose' };
    }
    return {
      ok: true,
      userId: payload.u,
      purpose: payload.p,
      category: payload.c,
    };
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
}
