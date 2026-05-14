import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));

/** Default iOS bundle IDs (Sign in with Apple); override with DAYFI_APPLE_CLIENT_IDS=com.a,com.b */
const DEFAULT_APPLE_AUDIENCES = [
  'com.dayfi.pilot',
  'com.dayfi.prod',
  'com.dayfi.test',
  'com.dayfi.app',
];

export function parseAppleAudiences(): string[] {
  const raw = process.env.DAYFI_APPLE_CLIENT_IDS?.trim();
  if (!raw) return DEFAULT_APPLE_AUDIENCES;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  rawNonce: string | undefined
): Promise<{ sub: string; email?: string }> {
  const audiences = parseAppleAudiences();
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: audiences,
  });

  if (rawNonce && typeof payload.nonce === 'string') {
    const expected = crypto.createHash('sha256').update(rawNonce).digest('hex');
    if (payload.nonce !== expected) {
      throw new Error('Invalid Apple sign-in nonce');
    }
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) {
    throw new Error('Invalid Apple identity token');
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return { sub, email };
}
