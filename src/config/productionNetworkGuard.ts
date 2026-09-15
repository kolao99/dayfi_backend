/**
 * Production network fail-closed guards for Stellar Mainnet + Ethereum Mainnet.
 * Prefer FAIL CLOSED over silent testnet/mock fallbacks.
 */

import StellarSdk from '@stellar/stellar-sdk';
import { getStellarConfig } from './stellarConfig';

export const STELLAR_MAINNET_PASSPHRASE = StellarSdk.Networks.PUBLIC;

export const ETHEREUM_MAINNET_CHAIN_ID = 1;

function nodeEnv(): string {
  return (
    process.env.DAYFI_NODE_ENV ||
    process.env.NODE_ENV ||
    ''
  )
    .trim()
    .toLowerCase();
}

/** True when this process must run on real mainnets (no testnet execution). */
export function isProductionRuntime(): boolean {
  if (nodeEnv() === 'production') return true;
  if (process.env.RAILWAY_ENVIRONMENT) return true;
  // Explicit ops override for dry-run containers that still must not use testnet.
  return (
    String(process.env.DAYFI_REQUIRE_MAINNET || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

export function assertStellarMainnetForProduction(): void {
  if (!isProductionRuntime()) return;

  const network = String(process.env.STELLAR_NETWORK || '')
    .trim()
    .toLowerCase();
  if (network !== 'mainnet') {
    throw new Error(
      `[FATAL] Production requires STELLAR_NETWORK=mainnet (got "${network || 'unset'}"). Refusing to start.`
    );
  }

  const cfg = getStellarConfig();
  if (cfg.isTestnet) {
    throw new Error(
      '[FATAL] Production Stellar config resolved to testnet. Refusing to start.'
    );
  }
  if (cfg.networkPassphrase !== STELLAR_MAINNET_PASSPHRASE) {
    throw new Error(
      `[FATAL] Production Stellar passphrase mismatch. Expected Mainnet PUBLIC passphrase.`
    );
  }
  if (
    cfg.horizonUrl.includes('testnet') ||
    cfg.horizonUrl.includes('futurenet') ||
    cfg.horizonUrl.includes('localhost') ||
    cfg.horizonUrl.includes('127.0.0.1')
  ) {
    throw new Error(
      `[FATAL] Production Stellar Horizon must be mainnet (got ${cfg.horizonUrl}).`
    );
  }

  // Infra live modes must not silently run mock in production consumer path —
  // but mock/off is OK for infra settlement. Only block if settlement is "live"
  // while pointing at testnet RPC (already blocked above via STELLAR_NETWORK).
}

export function assertEthereumMainnetForProduction(): void {
  if (!isProductionRuntime()) return;

  const ethNet = String(process.env.ETH_NETWORK || 'mainnet')
    .trim()
    .toLowerCase();
  if (ethNet && ethNet !== 'mainnet') {
    throw new Error(
      `[FATAL] Production requires ETH_NETWORK=mainnet (got "${ethNet}"). Refusing to start.`
    );
  }
}

/** Call before signing/submitting any Stellar payment in production. */
export function assertStellarTxNetworkSafe(passphrase: string): void {
  if (!isProductionRuntime()) return;
  if (passphrase !== STELLAR_MAINNET_PASSPHRASE) {
    throw new Error(
      '[FATAL] Refusing Stellar sign/submit: passphrase is not Mainnet PUBLIC.'
    );
  }
  const cfg = getStellarConfig();
  if (cfg.isTestnet || cfg.networkPassphrase !== STELLAR_MAINNET_PASSPHRASE) {
    throw new Error(
      '[FATAL] Refusing Stellar sign/submit: STELLAR_NETWORK is not mainnet.'
    );
  }
}

/** Call before signing/submitting any EVM tx in production. */
export async function assertEvmChainIdMainnet(
  provider: { getNetwork: () => Promise<{ chainId: bigint | number }> }
): Promise<void> {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (isProductionRuntime() && chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    throw new Error(
      `[FATAL] Refusing EVM submit: chainId=${chainId}, expected ${ETHEREUM_MAINNET_CHAIN_ID} (Ethereum Mainnet).`
    );
  }
  if (!isProductionRuntime() && chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    // Non-prod may still use mainnet RPCs; Sepolia not supported in evmChains table.
    throw new Error(
      `EVM chainId=${chainId} is not Ethereum Mainnet (${ETHEREUM_MAINNET_CHAIN_ID}). DayFi EVM rails are mainnet-only.`
    );
  }
}

/** Soft connectivity probe — does not mutate chain state. */
export async function probeStellarMainnetHorizon(): Promise<{
  ok: boolean;
  horizonUrl: string;
  detail: string;
}> {
  const cfg = getStellarConfig();
  try {
    const res = await fetch(cfg.horizonUrl.replace(/\/$/, '') + '/', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        ok: false,
        horizonUrl: cfg.horizonUrl,
        detail: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { network_passphrase?: string };
    const pass = body.network_passphrase || '';
    if (pass && pass !== cfg.networkPassphrase) {
      return {
        ok: false,
        horizonUrl: cfg.horizonUrl,
        detail: `Horizon passphrase mismatch`,
      };
    }
    return {
      ok: true,
      horizonUrl: cfg.horizonUrl,
      detail: pass || 'reachable',
    };
  } catch (err) {
    return {
      ok: false,
      horizonUrl: cfg.horizonUrl,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeEthereumMainnetRpc(rpcUrl: string): Promise<{
  ok: boolean;
  chainId: number | null;
  detail: string;
}> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
    });
    const body = (await res.json()) as { result?: string; error?: unknown };
    if (!body.result) {
      return { ok: false, chainId: null, detail: 'no chainId result' };
    }
    const chainId = parseInt(body.result, 16);
    if (chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
      return {
        ok: false,
        chainId,
        detail: `expected chainId 1`,
      };
    }
    return { ok: true, chainId, detail: 'ethereum mainnet' };
  } catch (err) {
    return {
      ok: false,
      chainId: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
