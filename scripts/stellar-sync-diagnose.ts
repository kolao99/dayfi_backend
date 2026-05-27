/**
 * Diagnose Stellar deposit → ledger sync for an address or user email.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/stellar-sync-diagnose.ts GDJ36T7Q...
 *   npx ts-node -r dotenv/config scripts/stellar-sync-diagnose.ts --email kola@example.com
 */
import StellarSdk from '@stellar/stellar-sdk';
import { configDotenv } from 'dotenv';
import { db } from '../src/config/database';
import {
  isStellarTestnet,
  resolveEurcIssuer,
  resolveUsdcIssuer,
} from '../src/config/stellarIssuers';
import { syncStellarInflowsToLedger } from '../src/modules/payment/cryptoInflowSyncService';

configDotenv();

const FUNDED_ADDRESS = 'GDJ36T7QU3NCXMI4EC4DLDCSRQFSL6QPZQSXAQYCAD5FADOBLNLPA2BX';

function horizonUrl(): string {
  return (
    process.env.STELLAR_HORIZON_URL?.trim() ||
    (isStellarTestnet()
      ? 'https://horizon-testnet.stellar.org'
      : 'https://horizon.stellar.org')
  );
}

async function horizonPayments(address: string) {
  const server = new StellarSdk.Horizon.Server(horizonUrl());
  const page = await server.payments().forAccount(address).limit(20).order('desc').call();
  return page.records as Record<string, unknown>[];
}

async function main() {
  const arg = process.argv[2];
  const emailFlag = process.argv.includes('--email');
  const email = emailFlag ? arg : undefined;
  const checkAddress = !emailFlag ? (arg || FUNDED_ADDRESS) : undefined;

  console.log('STELLAR_NETWORK=', process.env.STELLAR_NETWORK || '(default testnet)');
  console.log('Horizon=', horizonUrl());
  console.log('USDC issuer=', resolveUsdcIssuer());
  console.log('EURC issuer=', resolveEurcIssuer());

  const ledgerOk = await db.oneOrNone<{ exists: boolean }>(
    `SELECT to_regclass('public.ledger_movements') IS NOT NULL AS exists`
  );
  console.log('ledger_movements table=', ledgerOk?.exists ? 'YES' : 'MISSING');

  let userId: string | null = null;
  let dbAddress: string | null = null;

  if (email) {
    const user = await db.oneOrNone<{ user_id: string }>(
      `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    userId = user?.user_id ?? null;
    if (!userId) {
      console.error('No user for email:', email);
      process.exit(1);
    }
  } else if (checkAddress) {
    const row = await db.oneOrNone<{ user_id: string; stellar_deposit_address: string | null }>(
      `SELECT user_id, stellar_deposit_address FROM wallets
       WHERE stellar_deposit_address = $1 OR currency = 'USD'
       ORDER BY CASE WHEN stellar_deposit_address = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [checkAddress]
    );
    userId = row?.user_id ?? null;
    dbAddress = row?.stellar_deposit_address ?? null;

    const byAddr = await db.oneOrNone<{ user_id: string }>(
      `SELECT user_id FROM wallets WHERE stellar_deposit_address = $1 LIMIT 1`,
      [checkAddress]
    );
    if (byAddr) userId = byAddr.user_id;
  }

  if (userId) {
    const row = await db.oneOrNone<{
      stellar_deposit_address: string | null;
      balance: string;
      currency: string;
    }>(
      `SELECT stellar_deposit_address, balance, currency FROM wallets
       WHERE user_id = $1 AND currency IN ('USD', 'EUR') ORDER BY currency`,
      [userId]
    );
    const wallets = await db.manyOrNone<{ currency: string; balance: string }>(
      `SELECT currency, balance FROM wallets WHERE user_id = $1`,
      [userId]
    );
    dbAddress = (
      await db.oneOrNone<{ stellar_deposit_address: string | null }>(
        `SELECT stellar_deposit_address FROM wallets WHERE user_id = $1 AND currency = 'USD'`,
        [userId]
      )
    )?.stellar_deposit_address ?? null;

    console.log('\nDB user_id=', userId);
    console.log('DB stellar_deposit_address=', dbAddress || '(not set)');
    console.log('DB balances=', wallets);

    if (checkAddress && dbAddress && dbAddress !== checkAddress) {
      console.warn(
        '\n⚠️  MISMATCH: You funded',
        checkAddress,
        'but the app wallet is',
        dbAddress
      );
      console.warn('   Send crypto to the address shown in the app, or contact support to relink.');
    }
  }

  const address = checkAddress || dbAddress;
  if (!address) {
    console.error('No Stellar address to inspect');
    process.exit(1);
  }

  console.log('\nOn-chain payments for', address);
  const payments = await horizonPayments(address);
  for (const p of payments) {
    if (String(p.type) !== 'payment') continue;
    console.log(
      ' -',
      p.asset_code || 'XLM',
      p.amount,
      'from',
      String(p.from).slice(0, 8) + '…',
      'tx',
      String(p.transaction_hash).slice(0, 12) + '…'
    );
  }

  if (userId) {
    const walletsByCurrency: Record<string, { wallet_id: string; currency: string }> = {};
    const rows = await db.manyOrNone<{ wallet_id: string; currency: string }>(
      `SELECT wallet_id, currency FROM wallets WHERE user_id = $1`,
      [userId]
    );
    for (const w of rows) {
      walletsByCurrency[w.currency] = w;
    }
    console.log('\nRunning syncStellarInflowsToLedger…');
    const sync = await syncStellarInflowsToLedger({ userId, walletsByCurrency });
    console.log(JSON.stringify(sync, null, 2));

    const after = await db.manyOrNone<{ currency: string; balance: string }>(
      `SELECT currency, balance FROM wallets WHERE user_id = $1`,
      [userId]
    );
    console.log('Balances after sync:', after);
  }

  await db.$pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
