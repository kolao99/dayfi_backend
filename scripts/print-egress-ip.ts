/**
 * Print this host's public IPv4 (for Flutterwave / Yellow Card whitelisting).
 * Run on the VPS after deploy: npx ts-node -r dotenv/config scripts/print-egress-ip.ts
 */
import axios from 'axios';

async function main(): Promise<void> {
  const { data } = await axios.get<{ ip?: string }>(
    'https://api.ipify.org?format=json',
    { timeout: 10000 }
  );
  const ip = String(data?.ip || '').trim();
  if (!ip) {
    console.error('Could not determine public IPv4');
    process.exit(1);
  }
  console.log(ip);
  console.log('\nWhitelist this address at:');
  console.log('  Flutterwave → Settings → Whitelisted IP addresses');
  console.log('  Yellow Card → support / dashboard IP allowlist');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
