/**
 * Smoke-test Grey Business API connectivity.
 *
 *   npm run grey:smoke
 *
 * Requires: DAYFI_GREY_API_KEY, DAYFI_GREY_BASE_URL
 */
import 'dotenv/config';
import { GreyService } from '../src/modules/payment/greyService';

async function main() {
  const grey = new GreyService();
  if (!grey.isConfigured()) {
    console.error(
      'Set DAYFI_GREY_API_KEY and DAYFI_GREY_BASE_URL in .env (from Grey → Integrations).'
    );
    process.exit(1);
  }
  console.log('Grey configured. Fetching accounts…');
  try {
    const data = await grey.fetchProviderAccounts();
    console.log(JSON.stringify(data, null, 2));
    const ok = await grey.ping();
    console.log('ping:', ok ? 'ok' : 'failed');
  } catch (err: unknown) {
    console.error('Grey API error:', err instanceof Error ? err.message : err);
    console.error(
      'Tip: confirm DAYFI_GREY_BASE_URL matches the host shown in Grey Integrations (sandbox vs live).'
    );
    process.exit(1);
  }
}

main();
