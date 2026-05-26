/**
 * Call Yellow Card Business API from the terminal (same HMAC signing as YellowCardService).
 *
 * From repo root (loads .env first):
 *   npm run yc:smoke
 *   npm run yc:smoke -- rates NGN
 *   npm run yc:smoke -- networks
 *
 * Requires: DAYFI_YELLOWCARD_API_KEY, DAYFI_YELLOWCARD_API_SECRET, DAYFI_YELLOWCARD_BASE_URL
 */
import 'dotenv/config';

import { YellowCardService } from '../src/modules/payment/yellowCardService';

async function main(): Promise<void> {
  const yc = new YellowCardService();
  if (!yc.isConfigured()) {
    console.error(
      'Missing Yellow Card env. Set DAYFI_YELLOWCARD_API_KEY, DAYFI_YELLOWCARD_API_SECRET, DAYFI_YELLOWCARD_BASE_URL (see .env.example).'
    );
    process.exit(1);
  }

  const mode = process.argv[2] ?? 'channels';
  if (mode === 'rates') {
    const currency = process.argv[3] ?? 'NGN';
    console.log(`GET /business/rates?currency=${currency} …`);
    const data = await yc.fetchExchangeRates(currency);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (mode === 'networks') {
    console.log('GET /business/networks …');
    const data = await yc.fetchNetworks();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log('GET /business/channels …');
  const data = await yc.fetchChannels();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
