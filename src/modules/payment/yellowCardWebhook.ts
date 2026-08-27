import crypto from 'node:crypto';
import config from '../../config/env';
import { mapYellowCardProviderStatus } from './yellowCardStatus';

export type YellowCardWebhookPayload = {
  id?: string;
  sequenceId?: string;
  status?: string;
  event?: string;
  apiKey?: string;
  errorCode?: string;
  executedAt?: string;
};

export class YellowCardWebhookAuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'YellowCardWebhookAuthError';
    this.status = status;
  }
}

export function resolveYellowCardWebhookSecret(): string {
  return String(
    config?.YELLOWCARD_API_SECRET ||
      process.env.DAYFI_YELLOWCARD_API_SECRET ||
      process.env.YELLOWCARD_API_SECRET ||
      ''
  ).trim();
}

export function signYellowCardWebhook(
  rawBody: string | Buffer,
  secret: string
): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

export function verifyYellowCardWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secretOverride?: string
): boolean {
  const secret = String(
    secretOverride !== undefined ? secretOverride : resolveYellowCardWebhookSecret()
  ).trim();
  if (!secret || !signatureHeader?.trim()) return false;

  const expected = signYellowCardWebhook(rawBody, secret);

  try {
    const provided = Buffer.from(signatureHeader.trim());
    const computed = Buffer.from(expected);
    if (provided.length !== computed.length) return false;
    return crypto.timingSafeEqual(provided, computed);
  } catch {
    return false;
  }
}

/** Reject missing/invalid signatures before any lifecycle or ledger write. */
export function assertYellowCardWebhookAuthenticated(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secretOverride?: string
): void {
  const secret = String(
    secretOverride !== undefined ? secretOverride : resolveYellowCardWebhookSecret()
  ).trim();
  if (!secret) {
    throw new YellowCardWebhookAuthError(
      'Yellow Card webhook secret is not configured',
      503
    );
  }
  if (!String(signatureHeader || '').trim()) {
    throw new YellowCardWebhookAuthError('Missing webhook signature', 401);
  }
  if (!verifyYellowCardWebhookSignature(rawBody, signatureHeader, secret)) {
    throw new YellowCardWebhookAuthError('Invalid webhook signature', 401);
  }
}

export function resolveWalletStatusFromYellowCardWebhook(
  payload: YellowCardWebhookPayload
): string | null {
  const event = String(payload.event ?? '').trim().toUpperCase();
  const providerStatus = payload.status;

  if (providerStatus) {
    return mapYellowCardProviderStatus(providerStatus);
  }

  if (event.endsWith('.COMPLETE')) return 'success-payment';
  if (event.endsWith('.FAILED') || event.endsWith('.EXPIRED')) {
    return 'failed-payment';
  }
  if (
    event.includes('PENDING') ||
    event.includes('PROCESSING') ||
    event.includes('PROCESS')
  ) {
    return 'pending-payment';
  }

  return null;
}

export function isYellowCardSendWebhookEvent(event: string): boolean {
  const e = event.toUpperCase();
  return e.startsWith('PAYMENT.') || e.startsWith('SEND.');
}

export function isYellowCardReceiveWebhookEvent(event: string): boolean {
  const e = event.toUpperCase();
  return e.startsWith('COLLECTION.') || e.startsWith('RECEIVE.');
}
