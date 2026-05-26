import { db } from '../../config/database';
import { buildIdempotencyKey, newReference } from './balanceService';
import { convertAmountToUsd } from './fxService';

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

  const recipientWallet = await db.oneOrNone<{
    wallet_id: string;
    user_id: string;
  }>(
    `SELECT wallet_id, user_id FROM wallets
     WHERE dayfi_id = $1 AND currency = $2 LIMIT 1`,
    [params.recipientDayfiId, currency]
  );

  if (!recipientWallet) {
    throw new Error(`Recipient Dayfi tag not found for ${currency}`);
  }
  if (recipientWallet.user_id === params.senderUserId) {
    throw new Error('Cannot send to yourself');
  }

  const reference = newReference('p2p');
  const debitKey = buildIdempotencyKey('p2p-debit', reference);
  const creditKey = buildIdempotencyKey('p2p-credit', reference);

  const { usdAmount } = await convertAmountToUsd(amount, currency);

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
        JSON.stringify({ recipientUserId: recipientWallet.user_id }),
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

    await t.none(
      `INSERT INTO wallet_transactions (
         id, user_id, status, reason, send_amount, send_channel, timestamp
       ) VALUES ($1, $2, 'success-payment', $3, $4, 'wallet', NOW())`,
      [reference, params.senderUserId, `p2p:${params.recipientDayfiId}`, amount]
    );
  });

  const senderWallet = await db.one<{ balance: string }>(
    `SELECT balance FROM wallets WHERE wallet_id = $1`,
    [params.senderWalletId]
  );

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
