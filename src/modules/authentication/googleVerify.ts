import axios from 'axios';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Validates a Google OAuth **access token** (as sent by the Flutter client via
 * GoogleSignInAuthentication.accessToken) by calling Google's userinfo API.
 */
export async function verifyGoogleAccessToken(
  accessToken: string
): Promise<{ sub: string; email?: string }> {
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
  return { sub, email };
}
