import axios from 'axios';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Validates a Google OAuth **access token** (as sent by the Flutter client via
 * GoogleSignInAuthentication.accessToken) by calling Google's userinfo API.
 */
export type GoogleUserinfo = {
  sub: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
};

export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleUserinfo> {
  const token = idToken?.trim();
  if (!token) {
    throw new Error('Missing Google ID token');
  }

  let status: number;
  let data: any;
  try {
    const res = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { id_token: token },
      timeout: 15000,
      validateStatus: () => true,
    });
    status = res.status;
    data = res.data;
  } catch (e: any) {
    const msg =
      e?.response?.data?.error_description ||
      e?.response?.data?.error ||
      e?.message ||
      'Google sign-in verification failed';
    throw new Error(String(msg));
  }

  if (status !== 200 || data == null || typeof data !== 'object') {
    const err =
      typeof data?.error_description === 'string'
        ? data.error_description
        : 'Invalid or expired Google token';
    throw new Error(err);
  }

  const sub = typeof data.sub === 'string' ? data.sub : '';
  if (!sub) {
    throw new Error('Invalid Google token response');
  }

  return {
    sub,
    email: typeof data.email === 'string' ? data.email : undefined,
    given_name: typeof data.given_name === 'string' ? data.given_name : undefined,
    family_name:
      typeof data.family_name === 'string' ? data.family_name : undefined,
    name: typeof data.name === 'string' ? data.name : undefined,
  };
}

export async function verifyGoogleAccessToken(
  accessToken: string
): Promise<GoogleUserinfo> {
  const token = accessToken?.trim();
  if (!token) {
    throw new Error('Missing Google access token');
  }

  let status: number;
  let data: any;
  try {
    const res = await axios.get(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
      validateStatus: () => true,
    });
    status = res.status;
    data = res.data;
  } catch (e: any) {
    const msg =
      e?.response?.data?.error_description ||
      e?.response?.data?.error ||
      e?.message ||
      'Google sign-in verification failed';
    throw new Error(String(msg));
  }

  if (status !== 200 || data == null || typeof data !== 'object') {
    const err =
      typeof data?.error === 'string'
        ? String(data.error_description || data.error)
        : 'Invalid or expired Google token';
    throw new Error(err);
  }

  const sub = typeof data.sub === 'string' ? data.sub : '';
  if (!sub) {
    throw new Error('Invalid Google userinfo response');
  }

  const email = typeof data.email === 'string' ? data.email : undefined;
  const given_name =
    typeof data.given_name === 'string' ? data.given_name : undefined;
  const family_name =
    typeof data.family_name === 'string' ? data.family_name : undefined;
  const name = typeof data.name === 'string' ? data.name : undefined;
  return { sub, email, given_name, family_name, name };
}

/** Accepts either OAuth access token or OpenID id_token from mobile clients. */
export async function verifyGoogleAuthToken(
  authToken: string
): Promise<GoogleUserinfo> {
  const token = authToken?.trim();
  if (!token) throw new Error('Missing Google auth token');
  const looksLikeJwt = token.split('.').length === 3;
  if (looksLikeJwt) {
    try {
      return await verifyGoogleIdToken(token);
    } catch {
      return verifyGoogleAccessToken(token);
    }
  }
  try {
    return await verifyGoogleAccessToken(token);
  } catch {
    return verifyGoogleIdToken(token);
  }
}
