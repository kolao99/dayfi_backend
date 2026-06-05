/**
 * Call Flutterwave V3 from the terminal (same client as flutterwaveService).
 * Run on the VPS so egress IP matches Flutterwave whitelist.
 *
 *   npm run fw:smoke
 *   npm run fw:smoke -- bills
 */
import 'dotenv/config';

import { fetchBanks, fetchBillCategories } from '../src/modules/payment/flutterwaveService';

async function main(): Promise<void> {
  const key = String(process.env.DAYFI_FLUTTERWAVE_SECRET_KEY || '').trim();
  if (!key) {
    console.error('Set DAYFI_FLUTTERWAVE_SECRET_KEY (and related DAYFI_FLUTTERWAVE_* vars).');
    process.exit(1);
  }

  const mode = process.argv[2] ?? 'banks';
  if (mode === 'bills') {
    console.log('GET /v3/top-bill-categories?country=NG …');
    const categories = await fetchBillCategories('NG');
    console.log(`OK: ${categories.length} bill categories`);
    console.log(JSON.stringify(categories.slice(0, 3), null, 2));
    return;
  }

  console.log('GET /v3/banks/NG …');
  const { banks } = await fetchBanks();
  console.log(`OK: ${banks.length} Nigerian banks`);
  console.log(JSON.stringify(banks.slice(0, 5), null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
