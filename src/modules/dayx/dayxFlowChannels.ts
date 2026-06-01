import { YellowCardService } from '../payment/yellowCardService';

export type NormalizedChannel = {
  id: string;
  country: string;
  currency: string;
  channelType: string;
  rampType: string;
  label: string;
};

const COUNTRY_NAMES: Record<string, string> = {
  NG: 'Nigeria',
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Euro area',
  EU: 'Euro area',
  GH: 'Ghana',
  KE: 'Kenya',
  UG: 'Uganda',
  TZ: 'Tanzania',
  RW: 'Rwanda',
  ZA: 'South Africa',
  SN: 'Senegal',
  CM: 'Cameroon',
  CI: 'Ivory Coast',
  CD: 'DR Congo',
  CG: 'Republic of Congo',
  GA: 'Gabon',
  BJ: 'Benin',
  BF: 'Burkina Faso',
  BW: 'Botswana',
  MW: 'Malawi',
  ML: 'Mali',
  TG: 'Togo',
  ZM: 'Zambia',
};

export function countryLabel(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

function parseChannelList(raw: unknown): NormalizedChannel[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.channels)) list = o.channels;
    else if (Array.isArray(o.data)) list = o.data;
  }

  const out: NormalizedChannel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const country = String(c.country ?? '').toUpperCase();
    const currency = String(c.currency ?? '').toUpperCase();
    const rampType = String(c.rampType ?? c.ramp_type ?? '').toLowerCase();
    const status = String(c.status ?? 'active').toLowerCase();
    if (!country || !currency) continue;
    if (status !== 'active' && status !== 'enabled') continue;
    const allowedRamp =
      rampType === 'withdrawal' ||
      rampType === 'withdraw' ||
      rampType === 'payout' ||
      rampType === 'deposit' ||
      rampType === 'receive' ||
      rampType === '';
    if (!allowedRamp) continue;

    const channelType = String(
      c.channelType ?? c.channel_type ?? 'bank'
    ).toLowerCase();

    out.push({
      id: String(c.id ?? `${country}-${currency}-${channelType}`),
      country,
      currency,
      channelType,
      rampType,
      label: `${countryLabel(country)} (${currency})`,
    });
  }
  return out;
}

let cachedChannels: { at: number; list: NormalizedChannel[] } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function loadWithdrawCorridors(): Promise<NormalizedChannel[]> {
  const now = Date.now();
  if (cachedChannels && now - cachedChannels.at < CACHE_MS) {
    return cachedChannels.list;
  }
  const yc = new YellowCardService();
  const raw = await yc.fetchChannels();
  let list = parseChannelList(raw);
  if (!list.some((c) => c.country === 'NG' && c.currency === 'NGN')) {
    list.push({
      id: 'ng-ngn-bank',
      country: 'NG',
      currency: 'NGN',
      channelType: 'bank',
      rampType: 'withdraw',
      label: 'Nigeria (NGN)',
    });
  }
  cachedChannels = { at: now, list };
  return list;
}

export function uniqueCorridors(channels: NormalizedChannel[]): NormalizedChannel[] {
  const map = new Map<string, NormalizedChannel>();
  for (const ch of channels) {
    const key = `${ch.country}-${ch.currency}`;
    const prev = map.get(key);
    if (!prev || (ch.channelType === 'bank' && prev.channelType !== 'bank')) {
      map.set(key, ch);
    }
  }
  return [...map.values()].sort((a, b) => {
    const core = ['NG', 'US', 'GB', 'DE'];
    const ai = core.indexOf(a.country);
    const bi = core.indexOf(b.country);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.label.localeCompare(b.label);
  });
}

export function methodsForCorridor(
  channels: NormalizedChannel[],
  country: string,
  currency: string
): { id: string; label: string; subtitle: string }[] {
  const matches = channels.filter(
    (c) => c.country === country && c.currency === currency
  );
  const seen = new Set<string>();
  const methods: { id: string; label: string; subtitle: string }[] = [];

  const add = (id: string, label: string, subtitle: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    methods.push({ id, label, subtitle });
  };

  for (const ch of matches) {
    const t = ch.channelType;
    if (t.includes('dayfi')) {
      add('dayfi_tag', 'Dayfi Tag', 'Instant to another Dayfi user');
    } else if (t.includes('bank') || t === 'p2p' || t === 'eft') {
      add('bank', 'Bank transfer', 'Usually under 5 minutes');
    } else if (t.includes('mobile') || t.includes('momo')) {
      add('mobile_money', 'Mobile money', 'Instant');
    } else if (t.includes('crypto') || t.includes('wallet')) {
      add('crypto', 'Crypto wallet', 'On-chain transfer');
    }
  }

  if (country === 'NG' && currency === 'NGN') {
    add('bank', 'Bank transfer', 'Nigerian bank account');
    add('dayfi_tag', 'Dayfi Tag', 'Instant');
  }

  if (methods.length === 0) {
    add('bank', 'Bank transfer', 'Standard payout');
  }

  return methods;
}
