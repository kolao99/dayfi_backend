/**
 * Remove duplicate wallet history rows from a mis-run Grey USD deposit simulation.
 *
 *   npm run fix:grey-deposit -- kolawoleolufemi9@gmail.com
 */
import 'dotenv/config';

import { db } from '../src/config/database';
import { USD_BANK_DEPOSIT_REASON } from '../src/modules/payment/walletActivityService';

async function main(): Promise<void> {
  const email = String(process.argv[2] ?? 'kolawoleolufemi9@gmail.com')
    .trim()
    .toLowerCase();

  const user = await db.oneOrNone<{ user_id: string }>(
    `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (!user) {
    throw new Error(`User not found for email ${email}`);
  }

  const rows = await db.manyOrNone<{
    id: string;
    reason: string | null;
    receive_amount: string | null;
    receive_channel: string | null;
    external_reference: string | null;
    timestamp: Date;
  }>(
    `SELECT id, reason, receive_amount, receive_channel, external_reference, timestamp
     FROM wallet_transactions
     WHERE user_id = $1
       AND activity_kind = 'deposit'
       AND receive_amount >= 1499
       AND receive_amount <= 1501
     ORDER BY timestamp DESC`,
    [user.user_id]
  );

  if (!rows?.length) {
    console.log(JSON.stringify({ email, userId: user.user_id, message: 'No $1500 deposits found' }, null, 2));
    return;
  }

  const keep =
    rows.find((row) =>
      String(row.reason ?? '').toLowerCase().includes('usd bank deposit via wire')
    ) ??
    rows.find((row) => row.external_reference?.startsWith('grey-wire-sim-')) ??
    rows[0];

  const remove = rows.filter((row) => row.id !== keep.id);

  for (const row of remove) {
    await db.none(`DELETE FROM wallet_transactions WHERE id = $1`, [row.id]);
  }

  await db.none(
    `UPDATE wallet_transactions
     SET reason = $2,
         receive_channel = 'bank',
         ledger_currency = 'USD'
     WHERE id = $1`,
    [keep.id, USD_BANK_DEPOSIT_REASON]
  );

  await db.none(
    `UPDATE ledger_movements
     SET source = 'grey',
         external_reference = COALESCE(
           NULLIF(external_reference, 'grey'),
           external_reference
         )
     WHERE user_id = $1
       AND direction = 'credit'
       AND usd_equivalent >= 1499
       AND usd_equivalent <= 1501
       AND (source = 'USD' OR source = 'grey')`,
    [user.user_id]
  );

  console.log(
    JSON.stringify(
      {
        email,
        userId: user.user_id,
        kept: keep.id,
        removed: remove.map((row) => row.id),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
