import { db } from '../../config/database';

export type UserNotificationRow = {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
};

export async function createUserNotification(params: {
  userId: string;
  title: string;
  message: string;
  type?: string;
  metadata?: Record<string, unknown>;
}): Promise<UserNotificationRow> {
  return db.one<UserNotificationRow>(
    `INSERT INTO user_notifications (user_id, title, message, type, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      params.userId,
      params.title,
      params.message,
      params.type ?? 'general',
      JSON.stringify(params.metadata ?? {}),
    ]
  );
}

export async function listUserNotifications(
  userId: string,
  limit = 50
): Promise<UserNotificationRow[]> {
  return db.any<UserNotificationRow>(
    `SELECT * FROM user_notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
}

export async function markNotificationRead(
  userId: string,
  notificationId: string
): Promise<UserNotificationRow | null> {
  return db.oneOrNone<UserNotificationRow>(
    `UPDATE user_notifications
     SET is_read = true
     WHERE user_id = $1 AND id = $2
     RETURNING *`,
    [userId, notificationId]
  );
}

export async function notifyP2pRecipient(params: {
  recipientUserId: string;
  senderUserId: string;
  senderWalletId: string;
  amount: number;
  currency: string;
  reference: string;
}): Promise<void> {
  const sender = await db.oneOrNone<{
    first_name: string | null;
    last_name: string | null;
    dayfi_id: string | null;
  }>(
    `SELECT u.first_name, u.last_name, w.dayfi_id
     FROM users u
     JOIN wallets w ON w.user_id = u.user_id AND w.wallet_id = $1
     WHERE u.user_id = $2`,
    [params.senderWalletId, params.senderUserId]
  );

  const tag = String(sender?.dayfi_id ?? '').replace(/^@/, '');
  const name = `${sender?.first_name ?? ''} ${sender?.last_name ?? ''}`.trim();
  const senderLabel =
    tag.length > 0 ? `@${tag}` : name.length > 0 ? name : 'A Dayfi user';

  const symbol =
    params.currency === 'NGN'
      ? '₦'
      : params.currency === 'EUR'
        ? '€'
        : params.currency === 'GBP'
          ? '£'
          : '$';
  const formatted = `${symbol}${params.amount.toFixed(2)}`;

  await createUserNotification({
    userId: params.recipientUserId,
    title: 'Money received',
    message: `You received ${formatted} from ${senderLabel}`,
    type: 'P2P_RECEIVE',
    metadata: {
      type: 'P2P_RECEIVE',
      reference: params.reference,
      amount: params.amount,
      currency: params.currency,
      senderUserId: params.senderUserId,
      senderLabel,
    },
  });
}
