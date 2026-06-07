/**
 * Simulate a Grey USD wire deposit for a user (demo / QA).
 *
 *   npm run deposit:usd -- kolawoleolufemi9@gmail.com 1500
 */
import 'dotenv/config';

import { db } from '../src/config/database';
import PaymentService from '../src/modules/payment/services';

async function main(): Promise<void> {
  const email = String(process.argv[2] ?? 'kolawoleolufemi9@gmail.com')
    .trim()
    .toLowerCase();
  const amount = Number(process.argv[3] ?? 1500);

  if (!email) {
    throw new Error('Email is required');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }

  const user = await db.oneOrNone<{ user_id: string; email: string }>(
    `SELECT user_id, email FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (!user) {
    throw new Error(`User not found for email ${email}`);
  }

  const reference = `grey-wire-sim-${Date.now()}`;
  const paymentService = new PaymentService();

  const result = await paymentService.creditUnifiedUsdInflow(
    user.user_id,
    amount,
    'USD',
    'grey',
    reference
  );

  const wallet = await paymentService.getUsdWallet(user.user_id);

  console.log(
    JSON.stringify(
      {
        email: user.email,
        userId: user.user_id,
        creditedUsd: result.usdAmount,
        duplicate: result.duplicate,
        reference,
        newBalanceUsd: wallet ? Number(wallet.balance) : null,
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
