import { NextFunction, Request, Response } from 'express';
import { errorResponse } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { validateSessionToken } from './auth/sessionService';
import { touchLastSeen } from './auth/identityService';
import { getLinkByTelegramUserId } from './telegram/telegramLinkService';
import {
  isWebAppStubMode,
  validateTelegramWebAppInitData,
} from './telegram/telegramWebAppAuth';
import { FourError, isFourError } from './errors';
import { validateMetaWebhookSignature } from './whatsapp/metaCloudProvider';
import {
  isMetaWhatsappProvider,
  resolveWhatsappProvider,
} from './whatsapp/whatsappProviderEnv';
import { isWhatsappStubMode } from './whatsapp/whatsappClient';
import { verifyWhatsappSecureToken } from './whatsapp/whatsappSecureToken';

/**
 * Every /api/v1/four route except the two OTP endpoints runs behind this.
 *
 * The client presents an opaque Four session token; the server resolves it to a
 * user. Nothing downstream may read a user id from the request body — user
 * identity comes from the session and only from the session (rule §60).
 *
 * Mini App routes also accept validated Telegram WebApp initData — the URL
 * intent id is never trusted without this.
 */

export type FourAuthContext = {
  userId: string;
  authMethod: 'session' | 'telegram_webapp' | 'whatsapp_secure';
  sessionId?: string;
  /** Raw bearer token, needed by logout to revoke this exact session. */
  token?: string;
  telegramUserId?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      four?: FourAuthContext;
    }
  }
}

function bearerToken(req: Request): string | null {
  const header = String(req.headers.authorization || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}

export async function requireFourSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> {
  try {
    const token = bearerToken(req);
    if (!token) {
      return errorResponse(
        res,
        'Please sign in again.',
        enums.HTTP_UNAUTHORIZED
      );
    }

    const session = await validateSessionToken(token);
    // Unknown, revoked and expired tokens are indistinguishable by design.
    if (!session) {
      return errorResponse(
        res,
        'Please sign in again.',
        enums.HTTP_UNAUTHORIZED
      );
    }

    req.four = {
      userId: session.userId,
      sessionId: session.id,
      token,
      authMethod: 'session',
    };

    // Best-effort presence tracking; never blocks the request.
    touchLastSeen(session.userId).catch(() => undefined);

    return next();
  } catch (err) {
    console.error('[four/middleware] session validation failed', err);
    return errorResponse(
      res,
      'Please sign in again.',
      enums.HTTP_UNAUTHORIZED
    );
  }
}

/** Optional Telegram webhook secret validation. */
export function requireTelegramWebhookSecret(
  req: Request,
  res: Response,
  next: NextFunction
): any {
  const expected = String(process.env.FOUR_TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!expected) return next();

  const received = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (received !== expected) {
    return errorResponse(res, 'Unauthorized.', enums.HTTP_UNAUTHORIZED);
  }
  return next();
}

/** Validate Twilio webhook signatures for WhatsApp inbound messages. */
export function requireTwilioWhatsappWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): any {
  if (isWhatsappStubMode()) return next();

  const authToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!authToken) return next();

  const signature = String(req.headers['x-twilio-signature'] || '');
  if (!signature) {
    console.warn('[four/whatsapp] webhook rejected: missing x-twilio-signature');
    return errorResponse(res, 'Unauthorized.', enums.HTTP_UNAUTHORIZED);
  }

  const url = resolveTwilioWebhookUrl(req);
  const params = twilioWebhookParams(req.body);

  const valid = validateTwilioWebhookSignature({
    authToken,
    signature,
    url,
    params,
  });

  if (!valid) {
    console.warn(
      `[four/whatsapp] webhook signature invalid for url=${url} sid=${params.AccountSid ?? 'unknown'}`
    );
    return errorResponse(res, 'Unauthorized.', enums.HTTP_UNAUTHORIZED);
  }

  return next();
}

/** Validate Meta Cloud API webhook signatures (POST). */
export function requireMetaWhatsappWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): any {
  if (resolveWhatsappProvider() === 'stub') return next();

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const bodyBuffer =
    rawBody && rawBody.length
      ? rawBody
      : Buffer.from(JSON.stringify(req.body ?? {}));

  const signature = String(req.headers['x-hub-signature-256'] || '');
  if (
    !validateMetaWebhookSignature(bodyBuffer, signature || undefined)
  ) {
    console.warn('[four/whatsapp] Meta webhook signature invalid or missing');
    return errorResponse(res, 'Unauthorized.', enums.HTTP_UNAUTHORIZED);
  }

  return next();
}

/** POST webhook auth — Meta or Twilio depending on FOUR_WHATSAPP_PROVIDER. */
export function requireWhatsappWebhookPost(
  req: Request,
  res: Response,
  next: NextFunction
): any {
  if (isMetaWhatsappProvider()) {
    return requireMetaWhatsappWebhook(req, res, next);
  }
  return requireTwilioWhatsappWebhook(req, res, next);
}

function resolveTwilioWebhookUrl(req: Request): string {
  const configured = String(process.env.FOUR_WHATSAPP_WEBHOOK_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return `${proto}://${host}${req.originalUrl}`.replace(/\/$/, '');
}

function twilioWebhookParams(body: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (value == null) continue;
    params[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return params;
}

function validateTwilioWebhookSignature(input: {
  authToken: string;
  signature: string;
  url: string;
  params: Record<string, string>;
}): boolean {
  // Lazy import keeps middleware load light in tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Twilio = require('twilio') as typeof import('twilio');
  return Twilio.validateRequest(
    input.authToken,
    input.signature,
    input.url,
    input.params
  );
}

function readInitData(req: Request): string {
  const header = String(req.headers['x-telegram-init-data'] || '').trim();
  if (header) return header;
  const body = req.body?.initData;
  return typeof body === 'string' ? body.trim() : '';
}

/**
 * Mini App auth: validated Telegram initData → four_telegram_links → userId.
 * Falls back to Four session for local/dev when a bearer token is present.
 */
export async function requireFourSessionOrTelegramWebApp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> {
  const token = bearerToken(req);
  if (token) {
    const secure = verifyWhatsappSecureToken(token);
    if (secure.ok) {
      req.four = {
        userId: secure.userId,
        authMethod: 'whatsapp_secure',
        token,
      };
      touchLastSeen(secure.userId).catch(() => undefined);
      return next();
    }
    return requireFourSession(req, res, next);
  }

  try {
    const initData = readInitData(req);
    const botToken = String(process.env.FOUR_TELEGRAM_BOT_TOKEN || '').trim();

    if (!initData && isWebAppStubMode()) {
      const stubUserId = String(
        req.headers['x-telegram-stub-user-id'] || ''
      ).trim();
      if (stubUserId) {
        const link = await getLinkByTelegramUserId(stubUserId);
        if (!link) {
          throw new FourError('telegram_not_linked');
        }
        req.four = {
          userId: link.user_id,
          authMethod: 'telegram_webapp',
          telegramUserId: stubUserId,
        };
        return next();
      }
    }

    const validated = validateTelegramWebAppInitData(initData, botToken);
    if (!validated.ok) {
      throw new FourError('telegram_auth_invalid');
    }

    const link = await getLinkByTelegramUserId(validated.user.id);
    if (!link) {
      throw new FourError('telegram_not_linked');
    }

    req.four = {
      userId: link.user_id,
      authMethod: 'telegram_webapp',
      telegramUserId: String(validated.user.id),
    };

    touchLastSeen(link.user_id).catch(() => undefined);
    return next();
  } catch (err) {
    if (isFourError(err)) {
      return errorResponse(res, err.message, err.httpStatus);
    }
    console.error('[four/middleware] telegram webapp auth failed', err);
    return errorResponse(
      res,
      'Telegram verification failed. Please open this from Azap in Telegram.',
      enums.HTTP_UNAUTHORIZED
    );
  }
}
