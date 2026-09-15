/**
 * Live Yellow Card capability discovery for the multi-asset crypto engine.
 * Discovers candidate cryptoCurrency/cryptoNetwork pairs from the partner account.
 * Never enables user-facing trade from documentation alone.
 */

import {
  YellowCardService,
  parseYellowCardChannelList,
} from './yellowCardService';
import {
  listCatalogAssets,
  resolveEffectiveCapabilities,
  type EffectiveAssetCapability,
} from '../azap/crypto/assetRegistry';

export type YcDiscoveredPair = {
  cryptoCurrency: string;
  cryptoNetwork: string;
  source: 'channels' | 'networks' | 'rates' | 'heuristic';
};

export type YcCryptoCapabilitySnapshot = {
  probedAt: string;
  egressOk: boolean;
  channelsOk: boolean;
  networksOk: boolean;
  ratesOk: boolean;
  channelCount: number;
  networkCount: number;
  /** @deprecated prefer discoveredPairs */
  hasUsdc: boolean;
  hasEurc: boolean;
  hasStellarOrXlm: boolean;
  hasBtc: boolean;
  hasEth: boolean;
  hasSol: boolean;
  hasCryptoChannel: boolean;
  discoveredPairs: YcDiscoveredPair[];
  effectiveAssets: EffectiveAssetCapability[];
  buyDirectSettlementReady: boolean;
  sellDirectSettlementReady: boolean;
  blockers: string[];
  notes: string[];
};

let cached: { at: number; snapshot: YcCryptoCapabilitySnapshot } | null = null;
const CACHE_MS = 5 * 60 * 1000;

function forceEnabledByEnv(): boolean {
  return (
    String(process.env.DAYFI_YC_DIRECT_SETTLEMENT_FORCE || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

const KNOWN_CRYPTO = [
  'USDC',
  'EURC',
  'USDT',
  'BTC',
  'ETH',
  'SOL',
  'XLM',
  'TRX',
] as const;

const KNOWN_NETWORKS = [
  'XLM',
  'STELLAR',
  'ERC20',
  'ETHEREUM',
  'ETH',
  'BITCOIN',
  'BTC',
  'SOL',
  'SOLANA',
  'TRC20',
  'LIGHTNING',
] as const;

function pushPair(
  out: YcDiscoveredPair[],
  cryptoCurrency: string,
  cryptoNetwork: string,
  source: YcDiscoveredPair['source']
) {
  const c = cryptoCurrency.toUpperCase();
  const n = cryptoNetwork.toUpperCase();
  if (!c || !n) return;
  if (out.some((p) => p.cryptoCurrency === c && p.cryptoNetwork === n)) return;
  out.push({ cryptoCurrency: c, cryptoNetwork: n, source });
}

function extractPairsFromBlob(
  raw: unknown,
  source: YcDiscoveredPair['source']
): YcDiscoveredPair[] {
  const out: YcDiscoveredPair[] = [];
  const text = JSON.stringify(raw ?? '').toUpperCase();

  // Explicit fields on objects
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const o = node as Record<string, unknown>;
    const currency = String(
      o.cryptoCurrency || o.asset || o.currencyCode || o.currency || ''
    ).toUpperCase();
    const network = String(
      o.cryptoNetwork || o.network || o.chain || o.networkCode || ''
    ).toUpperCase();
    if (
      KNOWN_CRYPTO.includes(currency as (typeof KNOWN_CRYPTO)[number]) &&
      network &&
      /XLM|STELLAR|ERC20|ETH|BITCOIN|BTC|SOL|TRC20|LIGHTNING/.test(network)
    ) {
      const normalized =
        network === 'STELLAR'
          ? 'XLM'
          : network === 'ETH'
            ? 'ETHEREUM'
            : network;
      pushPair(out, currency, normalized, source);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(raw);

  // Heuristic: currency mentioned near network token in blob
  for (const c of KNOWN_CRYPTO) {
    if (!text.includes(c)) continue;
    for (const n of KNOWN_NETWORKS) {
      if (text.includes(n)) {
        // Avoid false positives like "ETH" in "Ethiopia" — require crypto context
        if (n === 'ETH' && !/CRYPTO|ERC20|ETHEREUM|WALLET/.test(text)) continue;
        if (
          (c === 'USDC' ||
            c === 'EURC' ||
            c === 'USDT' ||
            c === 'BTC' ||
            c === 'ETH' ||
            c === 'SOL') &&
          /CRYPTO|STABLE|SETTLEMENT|WALLET|DIRECT|XLM|ERC20|TRC20|BITCOIN|SOLANA|ETHEREUM/.test(
            text
          )
        ) {
          const normalized =
            n === 'STELLAR' ? 'XLM' : n === 'ETH' ? 'ETHEREUM' : n;
          pushPair(out, c, normalized, 'heuristic');
        }
      }
    }
  }

  return out;
}

/**
 * Probe live YC account for crypto convert / direct-settlement entitlement.
 * Non-monetary read-only calls only.
 */
export async function probeYellowCardCryptoCapabilities(options?: {
  forceRefresh?: boolean;
}): Promise<YcCryptoCapabilitySnapshot> {
  if (!options?.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.snapshot;
  }

  const yc = new YellowCardService();
  const blockers: string[] = [];
  const notes: string[] = [];
  const discoveredPairs: YcDiscoveredPair[] = [];

  const snapshot: YcCryptoCapabilitySnapshot = {
    probedAt: new Date().toISOString(),
    egressOk: yc.isConfigured(),
    channelsOk: false,
    networksOk: false,
    ratesOk: false,
    channelCount: 0,
    networkCount: 0,
    hasUsdc: false,
    hasEurc: false,
    hasStellarOrXlm: false,
    hasBtc: false,
    hasEth: false,
    hasSol: false,
    hasCryptoChannel: false,
    discoveredPairs,
    effectiveAssets: [],
    buyDirectSettlementReady: false,
    sellDirectSettlementReady: false,
    blockers,
    notes,
  };

  if (!yc.isConfigured()) {
    blockers.push('Yellow Card credentials are not configured');
    snapshot.effectiveAssets = resolveEffectiveCapabilities({
      ycPairs: [],
      forceTrade: false,
    });
    cached = { at: Date.now(), snapshot };
    return snapshot;
  }

  try {
    const channelsRaw = await yc.fetchChannels();
    const channels = parseYellowCardChannelList(channelsRaw);
    snapshot.channelsOk = true;
    snapshot.channelCount = channels.length;
    for (const p of extractPairsFromBlob(channels, 'channels')) {
      pushPair(discoveredPairs, p.cryptoCurrency, p.cryptoNetwork, p.source);
    }
    snapshot.hasCryptoChannel = channels.some((c) => {
      const t = String(c.channelType || c.type || '').toLowerCase();
      return /crypto|stable|digital|settlement/.test(t);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`channels probe failed: ${msg.slice(0, 180)}`);
  }

  try {
    const networksRaw = await yc.fetchNetworks();
    const networks = Array.isArray(networksRaw)
      ? networksRaw
      : (networksRaw as { networks?: unknown[]; data?: unknown[] })?.networks ||
        (networksRaw as { data?: unknown[] })?.data ||
        [];
    snapshot.networksOk = true;
    snapshot.networkCount = Array.isArray(networks) ? networks.length : 0;
    for (const p of extractPairsFromBlob(networks, 'networks')) {
      pushPair(discoveredPairs, p.cryptoCurrency, p.cryptoNetwork, p.source);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`networks probe failed: ${msg.slice(0, 180)}`);
  }

  try {
    const rates = await yc.fetchExchangeRates('NGN');
    snapshot.ratesOk = true;
    for (const p of extractPairsFromBlob(rates, 'rates')) {
      pushPair(discoveredPairs, p.cryptoCurrency, p.cryptoNetwork, p.source);
    }
    notes.push('rates endpoint reachable');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`rates probe failed: ${msg.slice(0, 180)}`);
  }

  snapshot.hasUsdc = discoveredPairs.some((p) => p.cryptoCurrency === 'USDC');
  snapshot.hasEurc = discoveredPairs.some((p) => p.cryptoCurrency === 'EURC');
  snapshot.hasBtc = discoveredPairs.some((p) => p.cryptoCurrency === 'BTC');
  snapshot.hasEth = discoveredPairs.some((p) => p.cryptoCurrency === 'ETH');
  snapshot.hasSol = discoveredPairs.some((p) => p.cryptoCurrency === 'SOL');
  snapshot.hasStellarOrXlm = discoveredPairs.some(
    (p) => p.cryptoNetwork === 'XLM' || p.cryptoNetwork === 'STELLAR'
  );

  if (!discoveredPairs.length && !snapshot.hasCryptoChannel) {
    blockers.push(
      'Live YC account probe found no cryptoCurrency/cryptoNetwork pairs (channels/networks/rates)'
    );
  }

  const forced = forceEnabledByEnv();
  if (forced) notes.push('DAYFI_YC_DIRECT_SETTLEMENT_FORCE=true (ops override)');

  snapshot.effectiveAssets = resolveEffectiveCapabilities({
    ycPairs: discoveredPairs,
    forceTrade: forced,
  });

  const anyTradeReady = snapshot.effectiveAssets.some(
    (a) => a.userExposedBuy || a.userExposedSell
  );
  snapshot.buyDirectSettlementReady = anyTradeReady;
  snapshot.sellDirectSettlementReady = anyTradeReady;

  if (!snapshot.buyDirectSettlementReady) {
    blockers.push(
      'No asset/network is user-exposed for YC buy/sell yet — need live pair discovery + wallet strategy + E2E'
    );
  }

  notes.push(
    `catalog=${listCatalogAssets().length}; discoveredPairs=${discoveredPairs.length}`
  );

  cached = { at: Date.now(), snapshot };
  return snapshot;
}

export function isYcCryptoBuyEnabled(
  snapshot: YcCryptoCapabilitySnapshot
): boolean {
  return snapshot.buyDirectSettlementReady;
}

export function isYcCryptoSellEnabled(
  snapshot: YcCryptoCapabilitySnapshot
): boolean {
  return snapshot.sellDirectSettlementReady;
}

export function resetYcCapabilityCacheForTests(): void {
  cached = null;
}
