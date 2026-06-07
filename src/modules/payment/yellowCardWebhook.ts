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

export function verifyYellowCardWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined
): boolean {
  const secret = String(config?.YELLOWCARD_API_SECRET ?? '').trim();
  if (!secret || !signatureHeader?.trim()) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader.trim()),
      Buffer.from(expected)
    );
  } catch {
    return signatureHeader.trim() === expected;
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
