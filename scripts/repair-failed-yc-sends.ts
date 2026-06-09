/**
 * Diagnose and repair unreversed failed Yellow Card wallet sends.
 *
 *   npx ts-node -r dotenv/config scripts/repair-failed-yc-sends.ts kolawoleolufemi9@gmail.com
 */
import 'dotenv/config';

import { db } from '../src/config/database';
import {
  repairUnreversedFailedYellowCardDebits,
} from '../src/modules/payment/walletActivityService';

async function main(): Promise<void> {
  const email = String(process.argv[2] ?? '').trim().toLowerCase();
  if (!email) {
    throw new Error('Usage: repair-failed-yc-sends.ts <email>');
  }

  const user = await db.oneOrNone<{
    user_id: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT user_id, first_name, last_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (!user) {
    throw new Error(`User not found for email ${email}`);
  }

  const wallet = await db.oneOrNone<{ balance: string; wallet_id: string }>(
    `SELECT balance, wallet_id FROM wallets
     WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [user.user_id]
  );

  const failedTxs = await db.manyOrNone<{
    id: string;
    status: string;
    send_amount: string | null;
    receive_amount: string | null;
    collection_sequence_id: string | null;
    timestamp: Date;
    reason: string | null;
  }>(
    `SELECT id, status, send_amount, receive_amount, collection_sequence_id, timestamp, reason
     FROM wallet_transactions
     WHERE user_id = $1
       AND activity_kind = 'withdrawal'
       AND send_channel = 'bank'
       AND status = 'failed-payment'
     ORDER BY timestamp DESC`,
    [user.user_id]
  );

  const ycDebits = await db.manyOrNone<{
    external_reference: string;
    amount: string;
    usd_equivalent: string;
    created_at: Date;
    has_reversal: boolean;
  }>(
    `SELECT lm.external_reference,
            lm.amount::text,
            lm.usd_equivalent::text,
            lm.created_at,
            EXISTS (
              SELECT 1 FROM ledger_movements rev
              WHERE rev.user_id = lm.user_id
                AND rev.direction = 'credit'
                AND COALESCE(rev.metadata->>'reversal', 'false') = 'true'
                AND (
                  rev.external_reference = lm.external_reference || '-reversal'
                  OR rev.metadata->>'originalReference' = lm.external_reference
                )
            ) AS has_reversal
     FROM ledger_movements lm
     WHERE lm.user_id = $1
       AND lm.direction = 'debit'
       AND lm.source = 'yellowcard'
     ORDER BY lm.created_at DESC`,
    [user.user_id]
  );

  const balanceBefore = Number(wallet?.balance ?? 0);
  const unreversed = (ycDebits ?? []).filter((d) => !d.has_reversal);
  const unreversedTotal = unreversed.reduce(
    (sum, d) => sum + Number(d.usd_equivalent ?? d.amount),
    0
  );

  console.log(
    JSON.stringify(
      {
        email,
        userId: user.user_id,
        name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim(),
        balanceBefore,
        failedWalletTransactions: failedTxs?.length ?? 0,
        yellowCardDebits: ycDebits?.length ?? 0,
        unreversedDebits: unreversed.length,
        unreversedTotalUsd: Number(unreversedTotal.toFixed(2)),
        failedTransactions: failedTxs,
        ledgerDebits: ycDebits,
      },
      null,
      2
    )
  );

  if (unreversed.length === 0) {
    console.log(JSON.stringify({ message: 'Nothing to repair' }, null, 2));
    return;
  }

  const repair = await repairUnreversedFailedYellowCardDebits(user.user_id);
  const walletAfter = await db.oneOrNone<{ balance: string }>(
    `SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [user.user_id]
  );

  console.log(
    JSON.stringify(
      {
        repair,
        balanceAfter: Number(walletAfter?.balance ?? 0),
        balanceDelta: Number(
          (Number(walletAfter?.balance ?? 0) - balanceBefore).toFixed(2)
        ),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
