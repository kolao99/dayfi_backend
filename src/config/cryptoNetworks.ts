/**
 * Supported crypto networks for receive UI and send routing.
 * EVM L2s share the same 0x deposit address as Ethereum mainnet.
 */
import {
  formatFeeUsd,
  resolveEvmChainConfig,
  type EvmChainKey,
} from './evmChains';

export type CryptoNetworkKey =
  | 'stellar'
  | 'ethereum'
  | 'bsc'
  | 'arbitrum'
  | 'sonic'
  | 'xdc'
  | 'mantle';

export type CryptoNetworkRail = 'stellar' | 'evm';

export type CryptoStableAsset = 'USDC' | 'EURC';

export interface CryptoNetworkDefinition {
  key: CryptoNetworkKey;
  name: string;
  subtitle: string;
  rail: CryptoNetworkRail;
  recommended?: boolean;
  sendEnabled: boolean;
  receiveEnabled: boolean;
  assets: CryptoStableAsset[];
  /** Estimated on-chain gas in USD (display). */
  estimatedNetworkFeeUsd: number;
}

function platformFeeUsd(): number {
  const raw = Number(process.env.DAYFI_TRANSFER_FEE_USD ?? 0.05);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.05;
}

function stellarNetworkFeeUsd(): number {
  return 0.01;
}

export const CRYPTO_NETWORKS: CryptoNetworkDefinition[] = [
  {
    key: 'stellar',
    name: 'Stellar',
    subtitle: 'Recommended',
    rail: 'stellar',
    recommended: true,
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC', 'EURC'],
    estimatedNetworkFeeUsd: stellarNetworkFeeUsd(),
  },
  {
    key: 'ethereum',
    name: 'Ethereum',
    subtitle: 'ERC-20',
    rail: 'evm',
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC', 'EURC'],
    estimatedNetworkFeeUsd:
      resolveEvmChainConfig('ethereum')?.estimatedNetworkFeeUsd ?? 2.5,
  },
  {
    key: 'bsc',
    name: 'BNB Smart Chain',
    subtitle: 'BEP-20',
    rail: 'evm',
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC'],
    estimatedNetworkFeeUsd:
      resolveEvmChainConfig('bsc')?.estimatedNetworkFeeUsd ?? 0.15,
  },
  {
    key: 'arbitrum',
    name: 'Arbitrum One',
    subtitle: 'ERC-20',
    rail: 'evm',
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC'],
    estimatedNetworkFeeUsd:
      resolveEvmChainConfig('arbitrum')?.estimatedNetworkFeeUsd ?? 0.2,
  },
  {
    key: 'mantle',
    name: 'Mantle Network',
    subtitle: 'ERC-20',
    rail: 'evm',
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC'],
    estimatedNetworkFeeUsd:
      resolveEvmChainConfig('mantle')?.estimatedNetworkFeeUsd ?? 0.05,
  },
  {
    key: 'sonic',
    name: 'Sonic',
    subtitle: 'ERC-20',
    rail: 'evm',
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC'],
    estimatedNetworkFeeUsd:
      resolveEvmChainConfig('sonic')?.estimatedNetworkFeeUsd ?? 0.02,
  },
  {
    key: 'xdc',
    name: 'XDC Network',
    subtitle: 'XRC-20',
    rail: 'evm',
    sendEnabled: true,
    receiveEnabled: true,
    assets: ['USDC'],
    estimatedNetworkFeeUsd:
      resolveEvmChainConfig('xdc')?.estimatedNetworkFeeUsd ?? 0.02,
  },
];

const KEY_SET = new Set(CRYPTO_NETWORKS.map((n) => n.key));

export function isCryptoNetworkKey(value: string): value is CryptoNetworkKey {
  return KEY_SET.has(value.toLowerCase() as CryptoNetworkKey);
}

export function getCryptoNetwork(key: string): CryptoNetworkDefinition | undefined {
  const normalized = key.toLowerCase();
  return CRYPTO_NETWORKS.find((n) => n.key === normalized);
}

function serializeNetwork(n: CryptoNetworkDefinition) {
  const platform = platformFeeUsd();
  return {
    key: n.key,
    name: n.name,
    subtitle: n.subtitle,
    rail: n.rail,
    recommended: n.recommended ?? false,
    enabled: n.sendEnabled,
    assets: n.assets,
    estimatedNetworkFeeUsd: n.estimatedNetworkFeeUsd,
    platformFeeUsd: platform,
    feeLabel: formatFeeUsd(n.estimatedNetworkFeeUsd),
    totalFeeLabel: formatFeeUsd(n.estimatedNetworkFeeUsd + platform),
  };
}

export function getCryptoSendConfigPayload() {
  const platform = platformFeeUsd();
  const networks = CRYPTO_NETWORKS.map(serializeNetwork);

  const assets: Record<string, CryptoNetworkKey[]> = {
    USDC: [],
    EURC: [],
  };

  for (const net of CRYPTO_NETWORKS) {
    for (const asset of net.assets) {
      if (!assets[asset].includes(net.key)) {
        assets[asset].push(net.key);
      }
    }
  }

  return {
    platformFeeUsd: platform,
    networks,
    assets,
  };
}

export function resolveDepositAddressForNetwork(
  networkKey: string,
  addresses: { stellar: string | null; evm: string | null }
): string {
  const net = getCryptoNetwork(networkKey);
  if (!net || !net.receiveEnabled) return '';
  if (net.rail === 'stellar') return String(addresses.stellar || '').trim();
  if (net.rail === 'evm') return String(addresses.evm || '').trim();
  return '';
}

export function buildReceiveNetworksPayload(addresses: {
  stellar: string | null;
  evm: string | null;
}) {
  const platform = platformFeeUsd();
  return CRYPTO_NETWORKS.map((n) => ({
    key: n.key,
    name: n.name,
    subtitle: n.subtitle,
    rail: n.rail,
    recommended: n.recommended ?? false,
    enabled: n.receiveEnabled,
    assets: n.assets,
    address: resolveDepositAddressForNetwork(n.key, addresses),
    estimatedNetworkFeeUsd: n.estimatedNetworkFeeUsd,
    platformFeeUsd: platform,
    feeLabel: formatFeeUsd(n.estimatedNetworkFeeUsd),
  }));
}

export function listSendEnabledNetworkKeys(): CryptoNetworkKey[] {
  return CRYPTO_NETWORKS.filter((n) => n.sendEnabled).map((n) => n.key);
}

export function resolveEvmChainKeyForSend(networkKey: string): EvmChainKey | null {
  const net = getCryptoNetwork(networkKey);
  if (!net?.sendEnabled || net.rail !== 'evm') return null;
  return net.key as EvmChainKey;
}
