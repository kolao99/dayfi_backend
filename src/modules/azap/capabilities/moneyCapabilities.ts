/**
 * Deterministic money capability registry.
 * Source of truth: backend `config/cryptoNetworks.ts` + dashboard Collect
 * filter in `listCryptoNetworks` (stellar, ethereum, bsc, arbitrum).
 * Fiat corridors: `infraCorridors.ts` (same set as dashboard Collect).
 */
import {
  CRYPTO_NETWORKS,
  getCryptoNetwork,
  type CryptoNetworkKey,
  type CryptoStableAsset,
} from '../../../config/cryptoNetworks';
import {
  YELLOW_CARD_OFF_RAMP_CORRIDORS,
  type YellowCardCorridor,
} from '../../infra/infraCorridors';

/**
 * Networks Azap + Collect expose for USDC/EURC deposits.
 * Keep this aligned with the verified Dayfi Collect receive set — do not
 * surface Mantle/Sonic/XDC until Collect/Dayfi advertise them as live.
 */
export const DASHBOARD_CRYPTO_NETWORK_KEYS: CryptoNetworkKey[] = [
  'stellar',
  'ethereum',
  'bsc',
  'arbitrum',
];

const ASSET_ALIASES: Record<string, CryptoStableAsset> = {
  usdc: 'USDC',
  'usd coin': 'USDC',
  usdcoin: 'USDC',
  eurc: 'EURC',
  'euro coin': 'EURC',
  eurocoin: 'EURC',
};

const NETWORK_ALIASES: Record<string, CryptoNetworkKey> = {
  stellar: 'stellar',
  xlm: 'stellar',
  'stellar network': 'stellar',
  ethereum: 'ethereum',
  eth: 'ethereum',
  erc20: 'ethereum',
  'erc-20': 'ethereum',
  'ethereum mainnet': 'ethereum',
  bsc: 'bsc',
  bnb: 'bsc',
  'bnb smart chain': 'bsc',
  'binance smart chain': 'bsc',
  bep20: 'bsc',
  'bep-20': 'bsc',
  arbitrum: 'arbitrum',
  'arbitrum one': 'arbitrum',
  mantle: 'mantle',
  'mantle network': 'mantle',
  sonic: 'sonic',
  xdc: 'xdc',
  'xdc network': 'xdc',
  xinfin: 'xdc',
};

function dashboardNetworks() {
  return CRYPTO_NETWORKS.filter((n) =>
    DASHBOARD_CRYPTO_NETWORK_KEYS.includes(n.key)
  );
}

export function getSupportedCryptoAssets(): CryptoStableAsset[] {
  const assets = new Set<CryptoStableAsset>();
  for (const n of dashboardNetworks()) {
    if (!n.receiveEnabled) continue;
    for (const a of n.assets) assets.add(a);
  }
  return [...assets];
}

export function getSupportedCryptoNetworks(
  asset: CryptoStableAsset,
  direction: 'receive' | 'send' = 'receive'
): Array<{
  key: CryptoNetworkKey;
  name: string;
  subtitle: string;
  recommended?: boolean;
}> {
  return dashboardNetworks()
    .filter((n) => n.assets.includes(asset))
    .filter((n) => (direction === 'receive' ? n.receiveEnabled : n.sendEnabled))
    .map((n) => ({
      key: n.key,
      name: n.name,
      subtitle: n.subtitle,
      recommended: n.recommended,
    }));
}

export function isCryptoDepositSupported(
  asset: string,
  network: string
): boolean {
  const a = normalizeCryptoAsset(asset);
  const n = normalizeCryptoNetwork(network);
  if (!a || !n) return false;
  const def = getCryptoNetwork(n);
  if (!def?.receiveEnabled) return false;
  if (!DASHBOARD_CRYPTO_NETWORK_KEYS.includes(n)) return false;
  return def.assets.includes(a);
}

export function isCryptoWithdrawalSupported(
  asset: string,
  network: string
): boolean {
  const a = normalizeCryptoAsset(asset);
  const n = normalizeCryptoNetwork(network);
  if (!a || !n) return false;
  const def = getCryptoNetwork(n);
  if (!def?.sendEnabled) return false;
  if (!DASHBOARD_CRYPTO_NETWORK_KEYS.includes(n)) return false;
  return def.assets.includes(a);
}

export function getSupportedFiatRails(): YellowCardCorridor[] {
  return YELLOW_CARD_OFF_RAMP_CORRIDORS;
}

export function isFiatPayoutSupported(
  country: string,
  currency: string,
  rail: 'bank' | 'momo'
): boolean {
  const row = YELLOW_CARD_OFF_RAMP_CORRIDORS.find(
    (c) =>
      c.countryCode.toUpperCase() === country.toUpperCase() &&
      c.currency.toUpperCase() === currency.toUpperCase()
  );
  if (!row) return false;
  return rail === 'bank' ? row.bank : row.mobileMoney;
}

export function normalizeCryptoAsset(raw: string): CryptoStableAsset | null {
  const q = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ASSET_ALIASES[q] ?? null;
}

export function normalizeCryptoNetwork(raw: string): CryptoNetworkKey | null {
  const q = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return NETWORK_ALIASES[q] ?? null;
}

export type ParsedCryptoDeposit = {
  asset: CryptoStableAsset | null;
  network: CryptoNetworkKey | null;
  amount: number | null;
  unknownAsset?: string | null;
  unknownNetwork?: string | null;
  wantsDepositAddress: boolean;
  wantsCryptoFunding: boolean;
  /** User is asking whether a deposit arrived — not starting a new deposit. */
  wantsDepositStatus: boolean;
};

/** Natural-language deposit / arrival status questions. */
export function isDepositStatusQuestion(text: string): boolean {
  const q = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return false;
  if (
    /^(did it arrive|has it arrived|received it yet|did you receive it|is (?:it|the deposit) in|where(?:'s| is) my (?:deposit|usdc|eurc|crypto))\??$/.test(
      q
    )
  ) {
    return true;
  }
  return (
    /\b(arrive[d]?|received|come through|detected|confirmed|in yet)\b/.test(q) &&
    /\b(yet|deposit|usdc|eurc|crypto|funds?|money|it|my)\b/.test(q)
  );
}

/** Extract a deposit amount when clearly tied to crypto (not phone numbers). */
export function parseCryptoDepositAmount(text: string): number | null {
  const q = String(text || '')
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return null;

  const patterns = [
    /(?:deposit|fund|receive|put|add)\s+\$?\s*(\d+(?:\.\d+)?)\s*(?:usdc|eurc|usd|eur)?\b/,
    /\$\s*(\d+(?:\.\d+)?)\s*(?:usdc|eurc|usd|eur)?\b/,
    /\b(\d+(?:\.\d+)?)\s*(?:usdc|eurc)\b/,
    /\b(?:usdc|eurc)\b(?:\s+\w+){0,4}\s+(\d+(?:\.\d+)?)\s*$/,
    /^(\d+(?:\.\d+)?)\s*(?:usd|eur)?$/,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (!m?.[1]) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) continue;
    // Reject bare 10-digit strings that look like account numbers.
    if (/^\d{8,}$/.test(m[1])) continue;
    return n;
  }
  return null;
}

export function parseCryptoDepositUtterance(text: string): ParsedCryptoDeposit {
  const q = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const looksLikeCryptoSend =
    /\b(send|withdraw|transfer)\b/.test(q) &&
    !/\b(deposit|receive|fund)\b/.test(q);

  const wantsDepositAddress =
    /(?:what(?:'s| is)|show|send me|give me).*(?:address|deposit)/.test(q) ||
    /(?:address|deposit address).*(?:usdc|eurc|stellar|ethereum)/.test(q) ||
    /(?:usdc|eurc).*(?:stellar|ethereum|bsc|arbitrum).*address/.test(q);

  let asset: CryptoStableAsset | null = null;
  let unknownAsset: string | null = null;
  if (/\busdc\b|usd coin/.test(q)) asset = 'USDC';
  else if (/\beurc\b|euro coin/.test(q)) asset = 'EURC';
  else {
    const m = q.match(
      /\b(usdt|btc|bitcoin|eth|sol|solana|dai|busd|tether)\b/
    );
    if (m) {
      const token = m[1];
      if (token === 'eth' && /\bethereum\b/.test(q)) {
        /* network only */
      } else if (token === 'sol' || token === 'solana') {
        if (/\b(deposit|fund|receive)\b/.test(q) && !/\busdc|eurc\b/.test(q)) {
          unknownAsset = 'SOL';
        }
      } else {
        unknownAsset =
          token === 'bitcoin'
            ? 'BTC'
            : token === 'tether'
              ? 'USDT'
              : token.toUpperCase();
      }
    }
  }

  let network: CryptoNetworkKey | null = null;
  let unknownNetwork: string | null = null;

  const netTry: Array<[RegExp, string]> = [
    [/\barbitrum(?:\s+one)?\b/, 'arbitrum'],
    [/\b(?:bnb(?:\s+smart)?\s*chain|bsc|bep-?20)\b/, 'bsc'],
    [/\bmantle(?:\s+network)?\b/, 'mantle'],
    [/\bsonic\b/, 'sonic'],
    [/\b(?:xdc(?:\s+network)?|xinfin)\b/, 'xdc'],
    [/\b(?:ethereum(?:\s+mainnet)?|erc-?20)\b/, 'ethereum'],
    [/\b(?:stellar(?:\s+network)?|xlm)\b/, 'stellar'],
    [/\bsolana\b/, 'solana'],
    [/\bbase\b/, 'base'],
    [/\bpolygon\b/, 'polygon'],
  ];
  for (const [re, key] of netTry) {
    if (!re.test(q)) continue;
    const n = normalizeCryptoNetwork(key);
    if (n) network = n;
    else unknownNetwork = key;
    break;
  }

  const amount = parseCryptoDepositAmount(q);
  const wantsDepositStatus = isDepositStatusQuestion(q);

  const naturalDepositPhrase =
    /\b(put|add|top\s*up)\b/.test(q) &&
    /\b(usdc|eurc)\b/.test(q) &&
    /\b(wallet|stellar|ethereum|bsc|arbitrum|crypto)\b/.test(q);

  const compactAssetNetwork =
    Boolean(asset && network) &&
    !looksLikeCryptoSend &&
    (/\b(deposit|fund|receive|wallet|put|add)\b/.test(q) ||
      /^(?:usdc|eurc)\b/.test(q));

  const wantsCryptoFunding =
    !wantsDepositStatus &&
    !looksLikeCryptoSend &&
    (wantsDepositAddress ||
      /\b(fund with crypto|deposit crypto|crypto deposit)\b/.test(q) ||
      (/\b(deposit|receive)\b/.test(q) &&
        /\b(usdc|eurc|stellar|ethereum|crypto|btc|bitcoin|usdt|solana|sol)\b/.test(
          q
        )) ||
      (/\bfund\b/.test(q) && /\b(usdc|eurc|crypto)\b/.test(q)) ||
      naturalDepositPhrase ||
      compactAssetNetwork ||
      (Boolean(asset) && amount != null && !looksLikeCryptoSend));

  return {
    asset,
    network,
    amount,
    unknownAsset,
    unknownNetwork,
    wantsDepositAddress,
    wantsCryptoFunding,
    wantsDepositStatus,
  };
}

export function formatSupportedAssetsLine(): string {
  return getSupportedCryptoAssets()
    .map((a) => `• ${a}`)
    .join('\n');
}

export function formatSupportedNetworksLine(asset: CryptoStableAsset): string {
  return getSupportedCryptoNetworks(asset, 'receive')
    .map((n) => `• ${n.name}${n.recommended ? ' (recommended)' : ''}`)
    .join('\n');
}

/** Short discovery examples only — not an exhaustive capability list. */
export function formatCryptoDepositExamples(): string {
  return ['• Deposit USDC on Stellar', '• Deposit EURC on Ethereum'].join('\n');
}

export function formatCryptoFundingAsk(
  missing: 'asset' | 'network',
  asset?: CryptoStableAsset
): string {
  if (missing === 'asset') {
    const examples = formatCryptoDepositExamples();
    return (
      'Ready to deposit crypto? 🪙\n\n' +
      'Tell me the asset and network.\n\n' +
      `For example:\n${examples}`
    );
  }
  const a = asset || 'USDC';
  return (
    `Which network for ${a}?\n\n` +
    `${formatSupportedNetworksLine(a)}\n\n` +
    'Which network would you like to use?'
  );
}

export function formatUnsupportedCrypto(input: {
  asset?: string | null;
  network?: string | null;
}): string {
  const assets = getSupportedCryptoAssets();
  const rawAsset = input.asset ? String(input.asset).trim() : '';
  const asset = rawAsset ? normalizeCryptoAsset(rawAsset) : null;
  const networkLabel = input.network
    ? String(input.network).replace(/\b\w/g, (c) => c.toUpperCase())
    : '';

  if (asset) {
    const nets = getSupportedCryptoNetworks(asset, 'receive');
    if (networkLabel) {
      return (
        `${asset} deposits aren't currently available on ${networkLabel}.\n\n` +
        `You can deposit ${asset} on:\n` +
        `${nets.map((n) => `• ${n.name}`).join('\n')}\n\n` +
        'Which network would you like to use?'
      );
    }
    return (
      `Which network for ${asset}?\n\n` +
      `${nets.map((n) => `• ${n.name}`).join('\n')}\n\n` +
      'Which network would you like to use?'
    );
  }

  const labeled = rawAsset ? rawAsset.toUpperCase() : 'that asset';
  return (
    'Azap currently supports stablecoin deposits. 🪙\n\n' +
    `Right now, you can deposit:\n` +
    `${assets.map((a) => `• ${a}`).join('\n')}\n\n` +
    `I can't deposit ${labeled} yet. Tell me which supported asset you'd like and your preferred network.`
  );
}
