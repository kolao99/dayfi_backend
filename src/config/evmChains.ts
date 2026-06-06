/**
 * EVM chain RPC + USDC contract addresses (mainnet defaults; override via env).
 */
import { isStellarTestnet } from './stellarIssuers';
import type { CryptoNetworkKey } from './cryptoNetworks';

export type EvmChainKey = Exclude<CryptoNetworkKey, 'stellar' | 'aptos'>;

export type EvmChainConfig = {
  key: EvmChainKey;
  rpcUrl: string;
  usdc: string;
  eurc: string | null;
  nativeSymbol: string;
  /** Typical ERC-20 transfer gas cost in USD (display estimate). */
  estimatedNetworkFeeUsd: number;
};

const MAINNET_CHAINS: Record<EvmChainKey, Omit<EvmChainConfig, 'key'>> = {
  ethereum: {
    rpcUrl: 'https://ethereum.publicnode.com',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    eurc: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
    nativeSymbol: 'ETH',
    estimatedNetworkFeeUsd: 2.5,
  },
  bsc: {
    rpcUrl: 'https://bsc.publicnode.com',
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    eurc: null,
    nativeSymbol: 'BNB',
    estimatedNetworkFeeUsd: 0.15,
  },
  arbitrum: {
    rpcUrl: 'https://arbitrum-one.publicnode.com',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    eurc: null,
    nativeSymbol: 'ETH',
    estimatedNetworkFeeUsd: 0.2,
  },
  mantle: {
    rpcUrl: 'https://mantle.publicnode.com',
    usdc: '0x09bc4E0D864854c596aCbF0AACf13857FF43CDE0',
    eurc: null,
    nativeSymbol: 'MNT',
    estimatedNetworkFeeUsd: 0.05,
  },
  sonic: {
    rpcUrl: 'https://rpc.soniclabs.com',
    usdc: '0x29219dd4000522a3657810310865e8346be66025',
    eurc: null,
    nativeSymbol: 'S',
    estimatedNetworkFeeUsd: 0.02,
  },
  xdc: {
    rpcUrl: 'https://erpc.xinfin.network',
    usdc: '0xD4C8aDbCE8BDAECa60A8768d06455A87972608f9',
    eurc: null,
    nativeSymbol: 'XDC',
    estimatedNetworkFeeUsd: 0.02,
  },
};

function envRpc(key: string, fallback: string): string {
  const envKey = `EVM_${key.toUpperCase()}_RPC_URL`;
  return process.env[envKey]?.trim() || fallback;
}

function envToken(key: string, asset: 'USDC' | 'EURC', fallback: string | null): string | null {
  const envKey = `EVM_${key.toUpperCase()}_${asset}_ADDRESS`;
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  return fallback;
}

export function resolveEvmChainConfig(chainKey: string): EvmChainConfig | null {
  if (isStellarTestnet()) {
    // Multi-chain EVM send/receive sync is mainnet-only for now.
    return null;
  }

  const key = chainKey.toLowerCase() as EvmChainKey;
  const base = MAINNET_CHAINS[key];
  if (!base) return null;

  return {
    key,
    rpcUrl: envRpc(key, base.rpcUrl),
    usdc: envToken(key, 'USDC', base.usdc) ?? base.usdc,
    eurc: envToken(key, 'EURC', base.eurc),
    nativeSymbol: base.nativeSymbol,
    estimatedNetworkFeeUsd: base.estimatedNetworkFeeUsd,
  };
}

export function listEvmChainsForSync(): EvmChainConfig[] {
  if (isStellarTestnet()) return [];
  return (Object.keys(MAINNET_CHAINS) as EvmChainKey[]).map((key) =>
    resolveEvmChainConfig(key)!
  );
}

export function resolveEvmTokenAddress(
  chainKey: string,
  assetCode: string
): string | null {
  const chain = resolveEvmChainConfig(chainKey);
  if (!chain) return null;
  const code = assetCode.toUpperCase();
  if (code === 'USDC') return chain.usdc;
  if (code === 'EURC') return chain.eurc;
  return null;
}

export function formatFeeUsd(amount: number): string {
  if (amount < 0.01) return '≈ $0.01';
  return `≈ $${amount.toFixed(2)}`;
}
