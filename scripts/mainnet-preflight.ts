/**
 * Production mainnet preflight — connectivity + config only (no value transfers).
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/mainnet-preflight.ts
 *   DAYFI_REQUIRE_MAINNET=true npx ts-node -r dotenv/config scripts/mainnet-preflight.ts
 */
import { getStellarConfig } from '../src/config/stellarConfig';
import {
  MAINNET_EURC_ISSUER,
  MAINNET_USDC_ISSUER,
  resolveEurcIssuer,
  resolveUsdcIssuer,
} from '../src/config/stellarIssuers';
import { resolveEvmChainConfig } from '../src/config/evmChains';
import {
  assertEthereumMainnetForProduction,
  assertStellarMainnetForProduction,
  ETHEREUM_MAINNET_CHAIN_ID,
  isProductionRuntime,
  probeEthereumMainnetRpc,
  probeStellarMainnetHorizon,
  STELLAR_MAINNET_PASSPHRASE,
} from '../src/config/productionNetworkGuard';

async function main() {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const cfg = getStellarConfig();
  checks.push({
    name: 'STELLAR_NETWORK',
    ok: cfg.network === 'mainnet' && !cfg.isTestnet,
    detail: cfg.network,
  });
  checks.push({
    name: 'STELLAR_PASSPHRASE',
    ok: cfg.networkPassphrase === STELLAR_MAINNET_PASSPHRASE,
    detail: cfg.isTestnet ? 'TESTNET' : 'PUBLIC/mainnet',
  });
  checks.push({
    name: 'STELLAR_HORIZON',
    ok:
      !cfg.horizonUrl.includes('testnet') &&
      !cfg.horizonUrl.includes('localhost'),
    detail: cfg.horizonUrl,
  });
  checks.push({
    name: 'USDC_ISSUER',
    ok: resolveUsdcIssuer(false) === MAINNET_USDC_ISSUER,
    detail: resolveUsdcIssuer(false).slice(0, 8) + '…',
  });
  checks.push({
    name: 'EURC_ISSUER',
    ok: resolveEurcIssuer(false) === MAINNET_EURC_ISSUER,
    detail: resolveEurcIssuer(false).slice(0, 8) + '…',
  });

  const eth = resolveEvmChainConfig('ethereum');
  checks.push({
    name: 'EVM_ETHEREUM_CONFIG',
    ok: Boolean(eth?.rpcUrl),
    detail: eth?.rpcUrl || 'missing (Stellar still testnet?)',
  });

  try {
    assertStellarMainnetForProduction();
    assertEthereumMainnetForProduction();
    checks.push({
      name: 'PRODUCTION_GUARDS',
      ok: true,
      detail: isProductionRuntime()
        ? 'production runtime enforced'
        : 'non-production (guards skipped)',
    });
  } catch (err) {
    checks.push({
      name: 'PRODUCTION_GUARDS',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const stellarProbe = await probeStellarMainnetHorizon();
  checks.push({
    name: 'HORIZON_CONNECTIVITY',
    ok: stellarProbe.ok,
    detail: stellarProbe.detail,
  });

  if (eth?.rpcUrl) {
    const ethProbe = await probeEthereumMainnetRpc(eth.rpcUrl);
    checks.push({
      name: 'ETH_CHAIN_ID',
      ok: ethProbe.ok && ethProbe.chainId === ETHEREUM_MAINNET_CHAIN_ID,
      detail: `chainId=${ethProbe.chainId} ${ethProbe.detail}`,
    });
  }

  const masterPk = process.env.MASTER_WALLET_PUBLIC_KEY?.trim();
  checks.push({
    name: 'MASTER_WALLET_PUBLIC_KEY',
    ok: Boolean(masterPk && /^G[A-Z0-9]{55}$/.test(masterPk)),
    detail: masterPk
      ? `${masterPk.slice(0, 8)}…${masterPk.slice(-4)}`
      : 'missing',
  });

  console.log('\n=== DayFi Mainnet Preflight ===\n');
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  console.log(
    failed
      ? `\n${failed} check(s) failed — NOT production-mainnet ready.\n`
      : '\nAll checks passed (connectivity + config). Still verify master XLM liquidity before provisioning users.\n'
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
