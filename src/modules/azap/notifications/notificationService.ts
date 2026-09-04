import crypto from 'crypto';
import { db } from '../../../config/database';
import {
  getNotificationTemplate,
  renderNotificationTemplate,
  type AzapNotificationEvent,
} from './templates';

export type AzapNotificationRecord = {
  id: string;
  userId: string;
  event: AzapNotificationEvent;
  channel: string;
  status: 'queued' | 'sent' | 'failed' | 'deduped';
  body: string;
  idempotencyKey: string;
};

/**
 * Queues a notification. Delivery adapters (WhatsApp send) are wired later.
 * Dedupes on (user_id, event, idempotency_key).
 */
export async function enqueueNotification(input: {
  userId: string;
  event: AzapNotificationEvent;
  channel: 'whatsapp' | 'email' | 'telegram';
  variables?: Record<string, string>;
  idempotencyKey: string;
  templateVersion?: string;
}): Promise<AzapNotificationRecord> {
  const template = getNotificationTemplate(
    input.event,
    input.templateVersion ?? 'v1'
  );
  const body = template
    ? renderNotificationTemplate(template, input.variables ?? {})
    : String(input.variables?.summary || input.event);

  const existing = await db.oneOrNone<{ id: string; status: string; body: string }>(
    `SELECT id, status, body FROM azap_notifications
      WHERE user_id = $1 AND event = $2 AND idempotency_key = $3`,
    [input.userId, input.event, input.idempotencyKey]
  );
  if (existing) {
    return {
      id: existing.id,
      userId: input.userId,
      event: input.event,
      channel: input.channel,
      status: 'deduped',
      body: existing.body,
      idempotencyKey: input.idempotencyKey,
    };
  }

  const id = `azap_ntf_${crypto.randomBytes(8).toString('hex')}`;
  await db.none(
    `INSERT INTO azap_notifications
       (id, user_id, event, channel, status, body, idempotency_key, template_version)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7)`,
    [
      id,
      input.userId,
      input.event,
      input.channel,
      body,
      input.idempotencyKey,
      input.templateVersion ?? 'v1',
    ]
  );

  return {
    id,
    userId: input.userId,
    event: input.event,
    channel: input.channel,
    status: 'queued',
    body,
    idempotencyKey: input.idempotencyKey,
  };
}
