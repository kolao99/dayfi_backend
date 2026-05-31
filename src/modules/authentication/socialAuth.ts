import enums from '../../shared/lib/enums';

export type AuthProvider = 'email' | 'google' | 'apple';
export type SocialAuthAction = 'login' | 'signup';

export function authProviderFromRefreshToken(
  refreshToken: string | null | undefined
): AuthProvider {
  const value = String(refreshToken ?? '').trim();
  if (value.startsWith('google:')) return 'google';
  if (value.startsWith('apple:')) return 'apple';
  return 'email';
}

export function signInMethodLabel(provider: AuthProvider): string {
  switch (provider) {
    case 'google':
      return 'Google';
    case 'apple':
      return 'Apple';
    default:
      return 'email and password';
  }
}

/** User-safe message when sign-in method does not match the registered provider. */
export function authProviderConflictMessage(
  existing: AuthProvider
): string {
  if (existing === 'google') {
    return 'This email is already registered with Google. Continue with Google to sign in.';
  }
  if (existing === 'apple') {
    return 'This email is already registered with Apple. Continue with Apple to sign in.';
  }
  if (existing === 'email') {
    return 'This email is registered with email and password. Sign in with your password instead.';
  }
  return 'An account with this email already exists. Use your original sign-in method.';
}

export function emailSignupBlockedMessage(existing: AuthProvider): string {
  if (existing === 'google') {
    return 'This email is already registered with Google. Continue with Google to sign in.';
  }
  if (existing === 'apple') {
    return 'This email is already registered with Apple. Continue with Apple to sign in.';
  }
  return 'An account with this email already exists. Please sign in.';
}

export function emailLoginBlockedMessage(existing: AuthProvider): string {
  if (existing === 'google') {
    return 'This account uses Google sign-in. Continue with Google on the welcome screen.';
  }
  if (existing === 'apple') {
    return 'This account uses Apple sign-in. Continue with Apple on the welcome screen.';
  }
  return enums.INVALID_LOGIN_DETAILS;
}

export class AuthProviderConflictError extends Error {
  readonly existingProvider: AuthProvider;
  readonly attemptedProvider: AuthProvider;

  constructor(existingProvider: AuthProvider, attemptedProvider: AuthProvider) {
    super(authProviderConflictMessage(existingProvider));
    this.name = 'AuthProviderConflictError';
    this.existingProvider = existingProvider;
    this.attemptedProvider = attemptedProvider;
  }
}

export function normalizeDayfiId(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}
