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

export type NotificationTypeCode =
  | 'P2P_RECEIVE'
  | 'P2P_SEND'
  | 'NGN_DEPOSIT'
  | 'BANK_SEND'
  | 'BILL_PAY'
  | 'BILL_PAY_FAILED'
  | 'general';

export function formatNotificationAmount(
  amount: number,
  currency: string
): string {
  const c = String(currency || 'USD').toUpperCase();
  const symbol =
    c === 'NGN'
      ? '₦'
      : c === 'EUR'
        ? '€'
        : c === 'GBP'
          ? '£'
          : '$';
  return `${symbol}${Number(amount).toFixed(2)}`;
}

export async function safeNotify(
  fn: () => Promise<void>,
  context: string
): Promise<void> {
  try {
    await fn();
  } catch (err: unknown) {
    console.warn(
      `[notifications] ${context}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function createUserNotification(params: {
  userId: string;
  title: string;
  message: string;
  type?: NotificationTypeCode | string;
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

export async function countUnreadNotifications(userId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM user_notifications
     WHERE user_id = $1 AND is_read = false`,
    [userId]
  );
  return Number(row.count) || 0;
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

export async function markAllNotificationsRead(
  userId: string
): Promise<number> {
  const rows = await db.manyOrNone<{ id: string }>(
    `UPDATE user_notifications
     SET is_read = true
     WHERE user_id = $1 AND is_read = false
     RETURNING id`,
    [userId]
  );
  return rows?.length ?? 0;
}

export async function notifyNgnBankDeposit(params: {
  userId: string;
  ngnAmount: number;
  usdCredited: number;
  reference: string;
}): Promise<void> {
  const ngn = formatNotificationAmount(params.ngnAmount, 'NGN');
  const usd = formatNotificationAmount(params.usdCredited, 'USD');
  await createUserNotification({
    userId: params.userId,
    title: 'NGN bank deposit',
    message: `${ngn} sent · ${usd} added to your wallet`,
    type: 'NGN_DEPOSIT',
    metadata: {
      type: 'NGN_DEPOSIT',
      reference: params.reference,
      ngnAmount: params.ngnAmount,
      usdCredited: params.usdCredited,
      currency: 'NGN',
    },
  });
}

export async function notifyBankSend(params: {
  userId: string;
  amount: number;
  currency: string;
  recipientName: string;
  bankName?: string;
  reference: string;
}): Promise<void> {
  const formatted = formatNotificationAmount(params.amount, params.currency);
  const bank = params.bankName?.trim();
  const detail = bank ? ` to ${params.recipientName} (${bank})` : ` to ${params.recipientName}`;
  await createUserNotification({
    userId: params.userId,
    title: 'Transfer sent',
    message: `${formatted} sent${detail}`,
    type: 'BANK_SEND',
    metadata: {
      type: 'BANK_SEND',
      reference: params.reference,
      amount: params.amount,
      currency: params.currency,
      recipientName: params.recipientName,
      bankName: params.bankName ?? null,
    },
  });
}

export async function notifyBillPaySuccess(params: {
  userId: string;
  amount: number;
  billerName: string;
  customerId: string;
  reference: string;
}): Promise<void> {
  const formatted = formatNotificationAmount(params.amount, 'NGN');
  await createUserNotification({
    userId: params.userId,
    title: 'Bill paid',
    message: `${formatted} paid to ${params.billerName}`,
    type: 'BILL_PAY',
    metadata: {
      type: 'BILL_PAY',
      reference: params.reference,
      amount: params.amount,
      currency: 'NGN',
      billerName: params.billerName,
      customerId: params.customerId,
    },
  });
}

export async function notifyBillPayFailed(params: {
  userId: string;
  amount: number;
  billerName: string;
  reference: string;
  reason?: string;
}): Promise<void> {
  const formatted = formatNotificationAmount(params.amount, 'NGN');
  await createUserNotification({
    userId: params.userId,
    title: 'Bill payment failed',
    message: `${formatted} to ${params.billerName} could not be completed. Your wallet was not charged.`,
    type: 'BILL_PAY_FAILED',
    metadata: {
      type: 'BILL_PAY_FAILED',
      reference: params.reference,
      amount: params.amount,
      currency: 'NGN',
      billerName: params.billerName,
      reason: params.reason ?? null,
    },
  });
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

  const formatted = formatNotificationAmount(params.amount, params.currency);

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

export async function notifyP2pSend(params: {
  senderUserId: string;
  recipientTag: string;
  amount: number;
  currency: string;
  reference: string;
}): Promise<void> {
  const formatted = formatNotificationAmount(params.amount, params.currency);
  const tag = params.recipientTag.replace(/^@/, '');
  await createUserNotification({
    userId: params.senderUserId,
    title: 'Transfer sent',
    message: `${formatted} sent to @${tag}`,
    type: 'P2P_SEND',
    metadata: {
      type: 'P2P_SEND',
      reference: params.reference,
      amount: params.amount,
      currency: params.currency,
      recipientTag: tag,
    },
  });
}
