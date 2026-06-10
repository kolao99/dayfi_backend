/**
 * Backfill wallet_transactions for DayEarn withdrawals that credited the ledger
 * but never mirrored into history (e.g. activity write failed on first attempt).
 *
 * Usage: npx ts-node scripts/backfill-dayearn-withdraw-activity.ts
 */
import { db } from '../src/config/database';
import {
  buildWalletActivityTxId,
  recordWalletActivity,
} from '../src/modules/payment/walletActivityService';

type LedgerRow = {
  user_id: string;
  amount: string;
  currency: string;
  external_reference: string | null;
  metadata: { potName?: string; action?: string } | null;
};

async function main() {
  const rows = await db.manyOrNone<LedgerRow>(
    `SELECT lm.user_id, lm.amount, lm.currency, lm.external_reference, lm.metadata
     FROM ledger_movements lm
     WHERE lm.source = 'dayearn'
       AND lm.direction = 'credit'
       AND lm.metadata->>'action' = 'withdraw'
       AND lm.external_reference IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM wallet_transactions wt
         WHERE wt.user_id = lm.user_id
           AND wt.external_reference = lm.external_reference
           AND wt.ledger_currency = lm.currency
       )`
  );

  if (!rows?.length) {
    console.log('No missing DayEarn withdrawal activity rows.');
    return;
  }

  let recorded = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    const currency = String(row.currency).toUpperCase();
    const reference = String(row.external_reference);
    const potName =
      typeof row.metadata?.potName === 'string' ? row.metadata.potName.trim() : '';

    const result = await recordWalletActivity({
      userId: row.user_id,
      id: buildWalletActivityTxId(reference),
      direction: 'credit',
      amount,
      currency,
      source: 'dayearn',
      title: potName ? `DayEarn · ${potName}` : 'DayEarn withdrawal',
      reason: potName
        ? `Withdrawal from ${potName} DayEarn pot`
        : 'Withdrawal from DayEarn pot',
      externalReference: reference,
      channel: 'wallet',
      beneficiaryName: 'DayEarn',
      accountType: 'dayearn',
      accountNumber: potName || undefined,
    });
    if (result.recorded) recorded += 1;
    console.log(
      `→ ${row.user_id} ${currency} ${amount} ref=${reference} recorded=${result.recorded}`
    );
  }

  console.log(`Done. ${recorded}/${rows.length} wallet activity rows written.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$pool.end());
