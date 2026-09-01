import crypto from 'crypto';

/**
 * Validates Telegram Mini App `initData` per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Never trust the intent id from the URL alone — this is how we bind the
 * WebApp opener to a linked Dayfi user.
 */

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type ValidateInitDataResult =
  | { ok: true; user: TelegramWebAppUser; authDate: number }
  | { ok: false; reason: string };

export function validateTelegramWebAppInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400
): ValidateInitDataResult {
  const raw = String(initData || '').trim();
  if (!raw) return { ok: false, reason: 'missing_init_data' };
  if (!botToken) return { ok: false, reason: 'bot_not_configured' };

  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };
  params.delete('hash');

  const pairs: string[] = [];
  params.forEach((value, key) => {
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculated = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (calculated !== hash) {
    return { ok: false, reason: 'invalid_hash' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: 'invalid_auth_date' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'expired' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'missing_user' };

  try {
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    if (!user?.id) return { ok: false, reason: 'invalid_user' };
    return { ok: true, user, authDate };
  } catch {
    return { ok: false, reason: 'invalid_user_json' };
  }
}

/** Test helper: build valid initData when FOUR_TELEGRAM_WEBAPP_STUB=1. */
export function buildStubInitData(
  telegramUserId: number,
  botToken = 'stub-bot-token'
): string {
  const user = JSON.stringify({ id: telegramUserId, first_name: 'Test' });
  const authDate = String(Math.floor(Date.now() / 1000));
  const params = new URLSearchParams({
    user,
    auth_date: authDate,
    query_id: 'stub',
  });

  const pairs: string[] = [];
  params.forEach((value, key) => pairs.push(`${key}=${value}`));
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  params.set('hash', hash);
  return params.toString();
}

export function isWebAppStubMode(): boolean {
  return (
    String(process.env.FOUR_TELEGRAM_WEBAPP_STUB || '').toLowerCase() ===
      'true' ||
    String(process.env.FOUR_TELEGRAM_MODE || '').toLowerCase() === 'stub'
  );
}
