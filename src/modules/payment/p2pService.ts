import { db } from '../../config/database';
import { buildIdempotencyKey, newReference } from './balanceService';
import { convertAmountToUsd } from './fxService';
import { notifyP2pRecipient } from '../notifications/notificationService';
import { normalizeDayfiId } from '../authentication/socialAuth';
import {
  buildWalletActivityTxId,
  recordWalletActivity,
} from './walletActivityService';

function countryForWalletCurrency(currency: string): string {
  switch (String(currency).toUpperCase()) {
    case 'USD':
      return 'US';
    case 'EUR':
      return 'EU';
    case 'GBP':
      return 'GB';
    default:
      return 'NG';
  }
}

async function resolveRecipientWalletForTag(
  recipientDayfiId: string,
  currency: string
): Promise<{ wallet_id: string; user_id: string }> {
  const normalizedTag = normalizeDayfiId(recipientDayfiId);
  if (!normalizedTag) {
    throw new Error('Invalid recipient Dayfi tag');
  }

  // Dayfi tags are stored on the USD wallet; resolve the user first.
  const tagOwner = await db.oneOrNone<{ user_id: string }>(
    `SELECT user_id FROM wallets
     WHERE LOWER(TRIM(BOTH '@' FROM COALESCE(dayfi_id, ''))) = $1
     LIMIT 1`,
    [normalizedTag]
  );

  if (!tagOwner?.user_id) {
    throw new Error('Recipient Dayfi tag not found');
  }

  const recipientWallet = await db.oneOrNone<{
    wallet_id: string;
    user_id: string;
  }>(
    `SELECT wallet_id, user_id FROM wallets
     WHERE user_id = $1 AND currency = $2
     LIMIT 1`,
    [tagOwner.user_id, currency]
  );

  if (!recipientWallet) {
    throw new Error(
      `Recipient cannot receive ${currency} transfers at this time`
    );
  }

  return recipientWallet;
}

async function resolveSenderP2pLabel(senderUserId: string): Promise<string> {
  const sender = await db.oneOrNone<{
    dayfi_id: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT w.dayfi_id, u.first_name, u.last_name
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.user_id AND w.currency = 'USD'
     WHERE u.user_id = $1
     LIMIT 1`,
    [senderUserId]
  );

  if (sender?.dayfi_id?.trim()) {
    return `@${String(sender.dayfi_id).replace(/^@/, '')}`;
  }
  const name = [sender?.first_name, sender?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || 'Dayfi user';
}

export async function transferByDayfiTag(params: {
  senderUserId: string;
  senderWalletId: string;
  recipientDayfiId: string;
  amount: number;
  currency: string;
}): Promise<{
  reference: string;
  recipientUserId: string;
  newBalance: number;
}> {
  const currency = String(params.currency).toUpperCase();
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid transfer amount');
  }

  const normalizedTag = normalizeDayfiId(params.recipientDayfiId);
  if (!normalizedTag) {
    throw new Error('Invalid recipient Dayfi tag');
  }

  const recipientWallet = await resolveRecipientWalletForTag(
    normalizedTag,
    currency
  );

  const recipientProfile = await db.oneOrNone<{
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT first_name, last_name FROM users WHERE user_id = $1 LIMIT 1`,
    [recipientWallet.user_id]
  );
  const recipientLegalName = [
    recipientProfile?.first_name,
    recipientProfile?.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const recipientBeneficiaryLabel = recipientLegalName
    ? `@${normalizedTag} · ${recipientLegalName}`
    : `@${normalizedTag}`;

  if (recipientWallet.user_id === params.senderUserId) {
    throw new Error('You cannot send to your own Dayfi Tag');
  }

  const reference = newReference('p2p');
  const debitKey = buildIdempotencyKey('p2p-debit', reference);
  const creditKey = buildIdempotencyKey('p2p-credit', reference);

  const { usdAmount } = await convertAmountToUsd(amount, currency);
  const recipientCountry = countryForWalletCurrency(currency);

  await db.tx(async (t) => {
    const sender = await t.one<{ balance: string }>(
      `SELECT balance FROM wallets
       WHERE wallet_id = $1 AND user_id = $2 AND currency = $3 FOR UPDATE`,
      [params.senderWalletId, params.senderUserId, currency]
    );
    if (Number(sender.balance) < amount) {
      throw new Error(`Insufficient ${currency} balance`);
    }

    await t.one<{ balance: string }>(
      `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 RETURNING balance`,
      [amount, params.senderWalletId]
    );

    const recipientAfter = await t.one<{ balance: string }>(
      `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
       WHERE wallet_id = $2 RETURNING balance`,
      [amount, recipientWallet.wallet_id]
    );

    await t.none(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'debit', $3, $4, $5, 'p2p', $6, $7, $8::jsonb)`,
      [
        params.senderUserId,
        params.senderWalletId,
        amount,
        currency,
        usdAmount,
        debitKey,
        reference,
        JSON.stringify({
          recipientUserId: recipientWallet.user_id,
          recipientDayfiId: normalizedTag,
        }),
      ]
    );

    await t.none(
      `INSERT INTO ledger_movements (
         user_id, wallet_id, direction, amount, currency, usd_equivalent,
         source, idempotency_key, external_reference, metadata
       ) VALUES ($1, $2, 'credit', $3, $4, $5, 'p2p', $6, $7, $8::jsonb)`,
      [
        recipientWallet.user_id,
        recipientWallet.wallet_id,
        amount,
        currency,
        usdAmount,
        creditKey,
        reference,
        JSON.stringify({
          senderUserId: params.senderUserId,
          balanceAfter: Number(recipientAfter.balance),
        }),
      ]
    );

    await t.none(
      `INSERT INTO p2p_transfers (reference, sender_user_id, recipient_user_id, amount_usd)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [reference, params.senderUserId, recipientWallet.user_id, usdAmount]
    );
  });

  const senderLabel = await resolveSenderP2pLabel(params.senderUserId);

  await recordWalletActivity({
    userId: params.senderUserId,
    id: buildWalletActivityTxId(`p2p-debit-${reference}`),
    direction: 'debit',
    amount,
    currency,
    source: 'p2p',
    title: `Transfer to @${normalizedTag}`,
    reason: `p2p:${normalizedTag}`,
    channel: 'wallet',
    status: 'success-payment',
    beneficiaryName: recipientBeneficiaryLabel,
    accountNumber: normalizedTag,
    accountType: 'dayfi',
    beneficiaryCountry: recipientCountry,
    externalReference: reference,
  });

  await recordWalletActivity({
    userId: recipientWallet.user_id,
    id: buildWalletActivityTxId(`p2p-credit-${reference}`),
    direction: 'credit',
    amount,
    currency,
    source: 'p2p',
    title: `Transfer from ${senderLabel}`,
    reason: `${currency} received via p2p from ${senderLabel}`,
    channel: 'wallet',
    status: 'success-collection',
    beneficiaryName: senderLabel,
    accountNumber: senderLabel.replace(/^@/, ''),
    accountType: 'dayfi',
    beneficiaryCountry: countryForWalletCurrency(currency),
    externalReference: reference,
  });

  const senderWallet = await db.one<{ balance: string }>(
    `SELECT balance FROM wallets WHERE wallet_id = $1`,
    [params.senderWalletId]
  );

  try {
    await notifyP2pRecipient({
      recipientUserId: recipientWallet.user_id,
      senderUserId: params.senderUserId,
      senderWalletId: params.senderWalletId,
      amount,
      currency,
      reference,
    });
  } catch (err: unknown) {
    console.warn(
      '[p2p] recipient notification failed:',
      err instanceof Error ? err.message : err
    );
  }

  return {
    reference,
    recipientUserId: recipientWallet.user_id,
    newBalance: Number(senderWallet.balance),
  };
}

/** @deprecated */
export const transferUsdByDayfiTag = (params: {
  senderUserId: string;
  senderWalletId: string;
  recipientDayfiId: string;
  amountUsd: number;
}) =>
  transferByDayfiTag({
    ...params,
    amount: params.amountUsd,
    currency: 'USD',
  });
