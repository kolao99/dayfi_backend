/**
 * Azap crypto capability registry — asset ≠ network ≠ custody ≠ provider.
 *
 * Doctrine: one crypto engine for all assets. USDC/EURC Stellar are the first
 * production paths. BTC/ETH/SOL and other YC assets use the same architecture
 * and are user-exposed only when wallet + YC + settlement + ledger E2E pass.
 *
 * Never hardcode "BTC is impossible." Gate on verified readiness instead.
 */

export type CryptoCustody = 'dayfi_ledger' | 'external_wallet' | 'yellowcard_direct';

export type WalletActivationStrategyId =
  | 'stellar_dayfi'
  | 'evm_dayfi'
  | 'bitcoin_pending'
  | 'solana_pending'
  | 'yc_hosted_pending';

export type AzapAssetNetworkConfig = {
  symbol: string;
  network: string;
  decimals: number;
  addressFormat: 'stellar' | 'evm' | 'bitcoin' | 'solana' | 'tron' | 'other';
  provider: 'dayfi' | 'yellowcard' | 'none';
  custody: CryptoCustody;
  walletStrategy: WalletActivationStrategyId;
  /** YC direct-settlement field values when known from docs/account. */
  ycCryptoCurrency?: string;
  ycCryptoNetwork?: string;
  /**
   * Static defaults — runtime effective flags come from
   * resolveEffectiveCapabilities() after live YC + wallet probes.
   */
  buyEnabled: boolean;
  sellEnabled: boolean;
  sendEnabled: boolean;
  receiveEnabled: boolean;
};

/**
 * Catalog of known asset/network rows for the crypto engine.
 * buy/sell defaults stay false until live entitlement + E2E pass.
 */
export const AZAP_ASSET_REGISTRY: AzapAssetNetworkConfig[] = [
  {
    symbol: 'USDC',
    network: 'stellar',
    decimals: 7,
    addressFormat: 'stellar',
    provider: 'dayfi',
    custody: 'dayfi_ledger',
    walletStrategy: 'stellar_dayfi',
    ycCryptoCurrency: 'USDC',
    ycCryptoNetwork: 'XLM',
    buyEnabled: false,
    sellEnabled: false,
    sendEnabled: true,
    receiveEnabled: true,
  },
  {
    symbol: 'EURC',
    network: 'stellar',
    decimals: 7,
    addressFormat: 'stellar',
    provider: 'dayfi',
    custody: 'dayfi_ledger',
    walletStrategy: 'stellar_dayfi',
    ycCryptoCurrency: 'EURC',
    ycCryptoNetwork: 'XLM',
    buyEnabled: false,
    sellEnabled: false,
    sendEnabled: true,
    receiveEnabled: true,
  },
  {
    symbol: 'USDC',
    network: 'ethereum',
    decimals: 6,
    addressFormat: 'evm',
    provider: 'dayfi',
    custody: 'dayfi_ledger',
    walletStrategy: 'evm_dayfi',
    ycCryptoCurrency: 'USDC',
    ycCryptoNetwork: 'ERC20',
    buyEnabled: false,
    sellEnabled: false,
    sendEnabled: false,
    receiveEnabled: false,
  },
  {
    symbol: 'BTC',
    network: 'bitcoin',
    decimals: 8,
    addressFormat: 'bitcoin',
    provider: 'yellowcard',
    custody: 'yellowcard_direct',
    walletStrategy: 'bitcoin_pending',
    ycCryptoCurrency: 'BTC',
    ycCryptoNetwork: 'BITCOIN',
    buyEnabled: false,
    sellEnabled: false,
    sendEnabled: false,
    receiveEnabled: false,
  },
  {
    symbol: 'ETH',
    network: 'ethereum',
    decimals: 18,
    addressFormat: 'evm',
    provider: 'dayfi',
    custody: 'dayfi_ledger',
    walletStrategy: 'evm_dayfi',
    ycCryptoCurrency: 'ETH',
    ycCryptoNetwork: 'ERC20',
    buyEnabled: false,
    sellEnabled: false,
    sendEnabled: false,
    receiveEnabled: false,
  },
  {
    symbol: 'SOL',
    network: 'solana',
    decimals: 9,
    addressFormat: 'solana',
    provider: 'yellowcard',
    custody: 'yellowcard_direct',
    walletStrategy: 'solana_pending',
    ycCryptoCurrency: 'SOL',
    ycCryptoNetwork: 'SOL',
    buyEnabled: false,
    sellEnabled: false,
    sendEnabled: false,
    receiveEnabled: false,
  },
];

export type EffectiveAssetCapability = AzapAssetNetworkConfig & {
  walletImplemented: boolean;
  ycDiscovered: boolean;
  userExposedBuy: boolean;
  userExposedSell: boolean;
  userExposedReceive: boolean;
  blockers: string[];
};

export function listEnabledAssets(
  capability: keyof Pick<
    AzapAssetNetworkConfig,
    'buyEnabled' | 'sellEnabled' | 'sendEnabled' | 'receiveEnabled'
  >
): AzapAssetNetworkConfig[] {
  return AZAP_ASSET_REGISTRY.filter((a) => a[capability]);
}

export function findAssetNetwork(
  symbol: string,
  network: string
): AzapAssetNetworkConfig | null {
  const s = symbol.toUpperCase();
  const n = normalizeNetworkKey(network);
  return (
    AZAP_ASSET_REGISTRY.find(
      (a) => a.symbol === s && normalizeNetworkKey(a.network) === n
    ) || null
  );
}

export function listCatalogAssets(): AzapAssetNetworkConfig[] {
  return [...AZAP_ASSET_REGISTRY];
}

export function normalizeNetworkKey(network: string): string {
  const n = String(network || '')
    .trim()
    .toLowerCase();
  if (
    n === 'xlm' ||
    n === 'stellar' ||
    n === 'stellar-mainnet' ||
    n === 'stellar-testnet'
  ) {
    return 'stellar';
  }
  if (n === 'erc20' || n === 'eth') return 'ethereum';
  if (n === 'btc' || n === 'bitcoin-mainnet') return 'bitcoin';
  return n;
}

export function isWalletStrategyImplemented(
  strategy: WalletActivationStrategyId
): boolean {
  return strategy === 'stellar_dayfi' || strategy === 'evm_dayfi';
}

export function normalizeYcNetworkToken(network: string): string {
  const n = String(network || '')
    .trim()
    .toUpperCase();
  if (n === 'STELLAR' || n === 'XLM') return 'XLM';
  if (n === 'ETH' || n === 'ETHEREUM' || n === 'ERC20') return 'ERC20';
  if (n === 'BTC' || n === 'BITCOIN') return 'BITCOIN';
  if (n === 'SOL' || n === 'SOLANA') return 'SOL';
  return n;
}

/**
 * Merge static catalog with live YC discovery.
 * User-facing buy/sell stays off unless both wallet strategy exists and YC pair is discovered
 * (or an explicit ops force + evidence). Never enable from documentation alone.
 */
export function resolveEffectiveCapabilities(input: {
  ycPairs: Array<{ cryptoCurrency: string; cryptoNetwork: string }>;
  forceTrade?: boolean;
}): EffectiveAssetCapability[] {
  const pairSet = new Set(
    input.ycPairs.map(
      (p) =>
        `${String(p.cryptoCurrency).toUpperCase()}::${normalizeYcNetworkToken(p.cryptoNetwork)}`
    )
  );

  return AZAP_ASSET_REGISTRY.map((row) => {
    const blockers: string[] = [];
    const walletImplemented = isWalletStrategyImplemented(row.walletStrategy);
    const ycKey =
      row.ycCryptoCurrency && row.ycCryptoNetwork
        ? `${row.ycCryptoCurrency.toUpperCase()}::${normalizeYcNetworkToken(row.ycCryptoNetwork)}`
        : '';
    const ycDiscovered = Boolean(ycKey && pairSet.has(ycKey));

    if (!walletImplemented) {
      blockers.push(`wallet strategy ${row.walletStrategy} not implemented yet`);
    }
    if (!ycDiscovered) {
      blockers.push('not discovered on live YC account probe');
    }

    // User exposure requires: static enable flag (set only after E2E) OR ops force,
    // plus wallet strategy + live YC pair evidence.
    const baseReady = walletImplemented && ycDiscovered;
    const userExposedBuy =
      baseReady && (row.buyEnabled || Boolean(input.forceTrade));
    const userExposedSell =
      baseReady && (row.sellEnabled || Boolean(input.forceTrade));
    const userExposedReceive = Boolean(row.receiveEnabled && walletImplemented);

    return {
      ...row,
      walletImplemented,
      ycDiscovered,
      userExposedBuy,
      userExposedSell,
      userExposedReceive,
      blockers,
    };
  });
}
