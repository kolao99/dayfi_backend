import { fetchBanks } from './flutterwaveService';
import YellowCardService from './yellowCardService';

export type YellowCardNetworkRow = {
  id: string;
  code?: string;
  name: string;
  country?: string;
  status?: string;
  channelIds?: string[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FW_BANK_CODE_RE = /^\d{3,6}$/;

/** Mirrors mobile / DayX bank picker aliases. */
const BANK_NAME_ALIASES: string[][] = [
  ['opay', 'paycom', 'o pay'],
  ['palmpay', 'palm pay'],
  ['gtbank', 'guaranty trust', 'gtb'],
  ['access bank', 'access'],
  ['united bank for africa', 'uba'],
  ['zenith'],
  ['kuda'],
  ['moniepoint', 'monie point'],
  ['first bank', 'firstbank', 'fbn'],
  ['fcmb', 'first city'],
  ['sterling'],
  ['wema', 'alat'],
  ['stanbic'],
  ['fidelity'],
  ['union bank'],
  ['polaris'],
  ['ecobank'],
  ['keystone'],
  ['providus'],
];

let cachedNetworks: YellowCardNetworkRow[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

function normalizeBankLabel(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bankTokens(raw: string): Set<string> {
  const normalized = normalizeBankLabel(raw);
  const tokens = new Set<string>();
  if (!normalized) return tokens;
  tokens.add(normalized);
  for (const group of BANK_NAME_ALIASES) {
    if (group.some((alias) => normalized.includes(alias))) {
      for (const alias of group) tokens.add(alias);
    }
  }
  for (const word of normalized.split(' ')) {
    if (word.length >= 3) tokens.add(word);
  }
  return tokens;
}

function namesMatch(a: string, b: string): boolean {
  const left = bankTokens(a);
  const right = bankTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  for (const token of left) {
    if (right.has(token)) return true;
    for (const other of right) {
      if (other.includes(token) || token.includes(other)) return true;
    }
  }
  return false;
}

export function parseYellowCardNetworks(raw: unknown): YellowCardNetworkRow[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { networks?: unknown[] }).networks)
      ? (raw as { networks: unknown[] }).networks
      : [];

  return list
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id ?? '').trim(),
        code: r.code != null ? String(r.code).trim() : undefined,
        name: String(r.name ?? '').trim(),
        country: r.country != null ? String(r.country).trim().toUpperCase() : undefined,
        status: r.status != null ? String(r.status).trim().toLowerCase() : undefined,
        channelIds: Array.isArray(r.channelIds)
          ? r.channelIds.map((id) => String(id).trim()).filter(Boolean)
          : undefined,
      };
    })
    .filter((row) => row.id && row.name);
}

async function loadYellowCardNetworks(
  yellowCardService: Pick<YellowCardService, 'fetchNetworks' | 'isConfigured'>
): Promise<YellowCardNetworkRow[]> {
  const now = Date.now();
  if (cachedNetworks && now - cachedAt < CACHE_TTL_MS) {
    return cachedNetworks;
  }
  if (!yellowCardService.isConfigured()) {
    return [];
  }
  const raw = await yellowCardService.fetchNetworks();
  cachedNetworks = parseYellowCardNetworks(raw).filter(
    (n) => n.status !== 'inactive'
  );
  cachedAt = now;
  return cachedNetworks;
}

export function matchYellowCardNetwork(params: {
  bankName: string;
  flutterwaveCode?: string;
  country?: string;
  channelId?: string;
  networks: YellowCardNetworkRow[];
}): YellowCardNetworkRow | null {
  const country = String(params.country ?? 'NG').trim().toUpperCase();
  const channelId = String(params.channelId ?? '').trim();
  const fwCode = String(params.flutterwaveCode ?? '').trim();

  let candidates = params.networks.filter(
    (n) => !n.country || n.country === country
  );

  if (channelId) {
    const forChannel = candidates.filter((n) =>
      n.channelIds?.includes(channelId)
    );
    if (forChannel.length > 0) candidates = forChannel;
  }

  if (fwCode) {
    const byCode = candidates.find((n) => n.code === fwCode);
    if (byCode) return byCode;
  }

  const byName = candidates.filter((n) =>
    namesMatch(params.bankName, n.name)
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const exact = byName.find(
      (n) => normalizeBankLabel(n.name) === normalizeBankLabel(params.bankName)
    );
    return exact ?? byName[0];
  }

  return null;
}

/**
 * Yellow Card expects network UUIDs. Mobile/recipients often store Flutterwave
 * bank codes (e.g. 100004 for Opay) from account resolve — map before payout.
 */
export async function resolveYellowCardNetworkId(params: {
  networkId: string;
  channelId: string;
  country?: string;
  bankName?: string;
  yellowCardService?: Pick<YellowCardService, 'fetchNetworks' | 'isConfigured'>;
}): Promise<string> {
  const networkId = String(params.networkId ?? '').trim();
  if (!networkId) {
    throw new Error('Bank network is required');
  }
  if (UUID_RE.test(networkId)) {
    return networkId;
  }

  if (!FW_BANK_CODE_RE.test(networkId)) {
    return networkId;
  }

  const yellowCardService = params.yellowCardService ?? new YellowCardService();
  const { banks } = await fetchBanks();
  const fwBank = banks.find((b) => b.code === networkId);
  const bankName = String(params.bankName ?? fwBank?.name ?? '').trim();
  if (!bankName && !fwBank) {
    throw new Error(
      'Unknown bank code. Select the bank again from the list and retry.'
    );
  }

  const ycNetworks = await loadYellowCardNetworks(yellowCardService);
  if (ycNetworks.length === 0) {
    throw new Error(
      'Unable to load payout networks. Try again in a moment.'
    );
  }

  const match = matchYellowCardNetwork({
    bankName: bankName || fwBank?.name || '',
    flutterwaveCode: networkId,
    country: params.country,
    channelId: params.channelId,
    networks: ycNetworks,
  });

  if (!match) {
    throw new Error(
      `Bank "${bankName || networkId}" is not supported on this payout channel. Pick another bank or contact support.`
    );
  }

  return match.id;
}
