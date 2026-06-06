/**
 * Reconcile Flutterwave NGN bank-transfer deposits that were not credited via webhook.
 *
 *   npm run fw:reconcile -- --id 9458189
 *   npm run fw:reconcile -- --recent
 */
import 'dotenv/config';

import {
  listFlutterwaveTransactions,
  verifyFlutterwaveTransactionById,
} from '../src/modules/payment/flutterwaveService';
import {
  enrichFlutterwaveDepositFromApi,
  parseFlutterwaveDepositWebhook,
  processFlutterwaveDeposit,
  repairFlutterwaveDepositActivities,
  type FlutterwaveDepositPayload,
} from '../src/modules/payment/flutterwaveInflowService';

function txToPayload(tx: Record<string, unknown>): FlutterwaveDepositPayload | null {
  return parseFlutterwaveDepositWebhook({
    event: 'charge.completed',
    data: tx,
  });
}

async function reconcileOne(id: string): Promise<void> {
  const tx = await verifyFlutterwaveTransactionById(id);
  let payload = txToPayload(tx);
  if (!payload) {
    console.log(`Skip ${id}: not a successful NGN bank transfer`);
    console.log(JSON.stringify(tx, null, 2));
    return;
  }
  payload = await enrichFlutterwaveDepositFromApi(payload);
  const result = await processFlutterwaveDeposit(payload);
  console.log(
    `OK id=${id} user=${result.userId} amount=${payload.amount} NGN duplicate=${result.duplicate} usd=${result.usdAmount}`
  );
}

async function reconcileRecent(): Promise<void> {
  const to = new Date();
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const rows = await listFlutterwaveTransactions({
    from: fmt(from),
    to: fmt(to),
    status: 'successful',
    currency: 'NGN',
  });

  console.log(`Found ${rows.length} successful NGN transactions (${fmt(from)} → ${fmt(to)})`);

  for (const row of rows) {
    const paymentType = String(row.payment_type ?? '').toLowerCase();
    if (paymentType && paymentType !== 'bank_transfer') continue;

    const id = String(row.id ?? '').trim();
    if (!id) continue;

    try {
      await reconcileOne(id);
    } catch (err: unknown) {
      console.warn(
        `Failed id=${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--id');
  if (idIdx >= 0 && args[idIdx + 1]) {
    await reconcileOne(String(args[idIdx + 1]).trim());
    return;
  }
  if (args.includes('--recent')) {
    await reconcileRecent();
    const repaired = await repairFlutterwaveDepositActivities();
    console.log(`Repaired ${repaired.repaired} wallet history row(s)`);
    return;
  }

  console.log('Usage:');
  console.log('  npm run fw:reconcile -- --id <flutterwave_transaction_id>');
  console.log('  npm run fw:reconcile -- --recent');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
