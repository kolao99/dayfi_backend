import crypto from 'crypto';
import { db } from '../../config/database';
import PaymentService from '../payment/services';
import YellowCardService, {
  parseYellowCardChannelList,
} from '../payment/yellowCardService';
import {
  buildCollectCorridors,
  buildCorridorDestinations,
} from './infraCorridors';
import {
  buildReceiveNetworksPayload,
  getCryptoSendConfigPayload,
} from '../../config/cryptoNetworks';
import {
  finalizePayoutDebit,
  lockPayoutFunds,
  releasePayoutLock,
  settleCollectionCredit,
} from './infraLifecycleService';
import {
  destinationToPayoutFields,
  resolveDestinationForPayout,
} from './infraRecipientService';
import { getOrgBalance } from './infraLedgerService';

export class InfraRailError extends Error {
  status: number;
  transactionId?: string;

  constructor(message: string, status = 502, transactionId?: string) {
    super(message);
    this.name = 'InfraRailError';
    this.status = status;
    this.transactionId = transactionId;
  }
}

export class InfraIdempotencyError extends Error {
  status: number;
  existingId?: string;

  constructor(message: string, existingId?: string) {
    super(message);
    this.name = 'InfraIdempotencyError';
    this.status = 409;
    this.existingId = existingId;
  }
}

function persistMoney(n: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e7) / 1e7;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`;
}

function fingerprintPayload(parts: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableJson(parts)).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      String((err as { code?: string }).code) === '23505'
  );
}

type YcParty = {
  name: string;
  country: string;
  phone: string;
  address: string;
  dob: string;
  email: string;
  idNumber: string;
  idType: string;
};

const PLACEHOLDER_PHONES = new Set(['+2348000000000', '2348000000000', '08000000000']);
const PLACEHOLDER_EMAILS = new Set([
  'collections@dayfi.co',
  'payouts@dayfi.co',
]);

function formatDob(raw: unknown): string {
  if (!raw) return '';
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

async function resolveLiveYellowCardParty(
  orgId: string,
  country: string,
  overrides?: { name?: string | null; phone?: string | null; email?: string | null }
): Promise<YcParty> {
  const member = await db.oneOrNone<{
    name: string | null;
    email: string | null;
    phone: string | null;
    date_of_birth: Date | string | null;
    address: string | null;
    bvn: string | null;
    country: string | null;
  }>(
    `SELECT name, email, phone, date_of_birth, address, bvn, country
     FROM infra_members
     WHERE org_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [orgId]
  );
  const org = await db.oneOrNone<{ name: string }>(
    `SELECT name FROM infra_organizations WHERE id = $1`,
    [orgId]
  );

  const name = String(overrides?.name || member?.name || org?.name || '').trim();
  const phone = String(overrides?.phone || member?.phone || '')
    .trim()
    .replace(/\s+/g, '');
  const email = String(overrides?.email || member?.email || '')
    .trim()
    .toLowerCase();
  const address = String(member?.address || '').trim();
  const dob = formatDob(member?.date_of_birth);
  const bvn = String(member?.bvn || '').replace(/\D/g, '');
  const partyCountry = String(country || member?.country || 'NG').toUpperCase();

  const missing: string[] = [];
  if (!name) missing.push('name');
  if (!phone || PLACEHOLDER_PHONES.has(phone)) missing.push('phone');
  if (!email || PLACEHOLDER_EMAILS.has(email)) missing.push('email');
  if (!address || address.toLowerCase() === 'not provided') missing.push('address');
  if (!dob) missing.push('date of birth');
  if (!/^\d{11}$/.test(bvn)) missing.push('BVN (11 digits)');

  if (missing.length) {
    throw new InfraRailError(
      `LIVE Yellow Card requires real KYC on the organization: missing ${missing.join(', ')}. Complete verification under Organization.`,
      400
    );
  }

  return {
    name,
    country: partyCountry,
    phone,
    address,
    dob,
    email,
    idNumber: bvn,
    idType: 'bvn',
  };
}

async function findIdempotentTx(
  orgId: string,
  env: string,
  key: string | undefined,
  fingerprint: string
) {
  const idem = String(key || '').trim();
  if (!idem) return null;
  const existing = await db.oneOrNone<{
    id: string;
    amount: string;
    currency: string;
    country: string | null;
    status: string;
    method: string;
    direction: string;
    fee: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
    request_fingerprint: string | null;
  }>(
    `SELECT id::text, amount::text, currency, country, status, method, direction, fee::text,
            external_id, metadata, created_at, request_fingerprint
     FROM infra_transactions
     WHERE org_id = $1 AND environment = $2 AND client_idempotency_key = $3
     LIMIT 1`,
    [orgId, env, idem]
  );
  if (!existing) return null;
  if (
    existing.request_fingerprint &&
    existing.request_fingerprint !== fingerprint
  ) {
    throw new InfraIdempotencyError(
      'Idempotency-Key reused with different parameters',
      existing.id
    );
  }
  return existing;
}

type Env = 'test' | 'live';

export type CreateCollectionInput = {
  orgId: string;
  env: Env;
  amount: number;
  currency?: string;
  country?: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
  channelId?: string;
  /** bank | momo | crypto */
  method?: string;
  asset?: string;
  network?: string;
  depositAddress?: string;
  idempotencyKey?: string;
};

export type CreatePayoutInput = {
  orgId: string;
  env: Env;
  amount: number;
  currency?: string;
  country?: string;
  accountNumber?: string;
  accountName?: string;
  bankCode?: string;
  bankName?: string;
  networkId?: string;
  channelId?: string;
  reason?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  /** bank | momo | crypto | dayfi_tag */
  accountType?: string;
  asset?: string;
  network?: string;
  walletAddress?: string;
  dayfiTag?: string;
  /** Phase 3: payout to a saved recipient destination */
  recipientId?: string;
  destinationId?: string;
  /** Phase 4: link child payout to bulk batch item */
  bulkBatchId?: string;
  bulkItemId?: string;
  idempotencyKey?: string;
};

async function insertTx(row: {
  orgId: string;
  env: Env;
  amount: number;
  currency: string;
  country: string | null;
  status: string;
  method: string;
  direction: 'payment' | 'payout';
  fee?: number;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  fingerprint?: string | null;
}) {
  const idem = String(row.idempotencyKey || '').trim() || null;
  try {
    return await db.one<{
      id: string;
      amount: string;
      currency: string;
      country: string | null;
      status: string;
      method: string;
      direction: string;
      fee: string;
      external_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `INSERT INTO infra_transactions
        (org_id, environment, amount, currency, country, status, method, direction, fee, external_id, metadata,
         client_idempotency_key, request_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       RETURNING id::text, amount::text, currency, country, status, method, direction, fee::text,
                 external_id, metadata, created_at`,
      [
        row.orgId,
        row.env,
        persistMoney(row.amount),
        row.currency,
        row.country,
        row.status,
        row.method,
        row.direction,
        persistMoney(row.fee || 0),
        row.externalId || null,
        JSON.stringify(row.metadata || {}),
        idem,
        row.fingerprint || null,
      ]
    );
  } catch (err) {
    if (isUniqueViolation(err) && idem) {
      const existing = await findIdempotentTx(
        row.orgId,
        row.env,
        idem,
        row.fingerprint || ''
      );
      if (existing) return existing;
    }
    throw err;
  }
}

async function fetchTxRow(id: string) {
  return db.one<{
    id: string;
    amount: string;
    currency: string;
    country: string | null;
    status: string;
    method: string;
    direction: string;
    fee: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id::text, amount::text, currency, country, status, method, direction, fee::text,
            external_id, metadata, created_at
     FROM infra_transactions
     WHERE id = $1`,
    [id]
  );
}

function mapTx(row: {
  id: string;
  amount: string | number;
  currency: string;
  country: string | null;
  status: string;
  method: string;
  direction: string;
  fee?: string | number;
  external_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at: Date;
}) {
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    country: row.country,
    status: row.status,
    method: row.method,
    direction: row.direction,
    fee: Number(row.fee || 0),
    externalId: row.external_id || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

export async function listBanks() {
  const paymentService = new PaymentService();
  try {
    const networks = await paymentService.fetchNigerianBankNetworks();
    return networks.map((n) => ({
      id: n.id,
      code: n.code,
      name: n.name,
      country: n.country,
      channelIds: n.channelIds,
    }));
  } catch (err) {
    console.warn('[infra-money] banks fallback', err);
    // Minimal fallback so TEST UI works when Flutterwave is unreachable
    return [
      { id: '058', code: '058', name: 'Guaranty Trust Bank', country: 'NG', channelIds: [] },
      { id: '033', code: '033', name: 'United Bank For Africa', country: 'NG', channelIds: [] },
      { id: '011', code: '011', name: 'First Bank of Nigeria', country: 'NG', channelIds: [] },
      { id: '057', code: '057', name: 'Zenith Bank', country: 'NG', channelIds: [] },
      { id: '221', code: '221', name: 'Stanbic IBTC Bank', country: 'NG', channelIds: [] },
    ];
  }
}

export async function resolveBank(accountNumber: string, bankCode: string) {
  const paymentService = new PaymentService();
  const resolved = await paymentService.resolveBankAccount(
    String(accountNumber).trim(),
    String(bankCode).trim()
  );
  return {
    accountName: resolved.accountName,
    accountNumber: resolved.accountNumber,
    bankCode: resolved.bankCode,
    bankName: resolved.bankName,
  };
}

export async function listChannels() {
  const yc = new YellowCardService();
  if (yc.isConfigured()) {
    try {
      const raw = await yc.fetchChannels();
      return parseYellowCardChannelList(raw).map((c) => ({
        id: String(c.id ?? c.channelId ?? ''),
        name: String(c.name ?? c.channelName ?? 'Channel'),
        currency: String(c.currency ?? c.localCurrency ?? ''),
        country: String(c.country ?? ''),
        channelType: String(c.channelType ?? c.type ?? ''),
        rampType: String(c.rampType ?? c.ramp ?? ''),
        status: String(c.status ?? 'active'),
        min: c.min ?? null,
        max: c.max ?? null,
      }));
    } catch (err) {
      console.warn('[infra-money] YC channels unavailable — using corridor catalog', err);
    }
  }
  // Fallback when YC IP-blocked locally — same corridors mobile seeds
  return buildCorridorDestinations().flatMap((c) =>
    c.methods.map((m) => ({
      id: `yc_fallback_${c.countryCode}_${c.currency}_${m}`,
      name: `${c.name} ${m === 'momo' ? 'Mobile money' : 'Bank'}`,
      currency: c.currency,
      country: c.countryCode,
      channelType: m === 'momo' ? 'momo' : 'bank',
      rampType: 'withdrawal',
      status: 'active',
      min: null,
      max: null,
    }))
  );
}

export async function listCorridors() {
  const live = await listChannels();
  const destinations = buildCorridorDestinations().map((c) => {
    const matches = live.filter(
      (ch) =>
        ch.country?.toUpperCase() === c.countryCode &&
        ch.currency?.toUpperCase() === c.currency
    );
    const bankChannel = matches.find((ch) =>
      ['bank', 'bank_transfer', 'eft'].includes(String(ch.channelType).toLowerCase())
    );
    const momoChannel = matches.find((ch) =>
      ['momo', 'mobile_money', 'mobile-money'].includes(
        String(ch.channelType).toLowerCase()
      )
    );
    return {
      ...c,
      bankChannelId: bankChannel?.id || null,
      momoChannelId: momoChannel?.id || null,
      live: matches.length > 0 && !String(matches[0].id).startsWith('yc_fallback_'),
    };
  });

  return {
    destinations,
    collect: buildCollectCorridors(),
    source: 'dayfi',
  };
}

export function listCryptoNetworks(asset?: string) {
  const stellar =
    process.env.DAYFI_INFRA_STELLAR_ADDRESS ||
    process.env.MASTER_WALLET_PUBLIC_KEY ||
    null;
  const evm =
    process.env.DAYFI_INFRA_EVM_ADDRESS ||
    process.env.MASTER_WALLET_EVM_ADDRESS ||
    null;
  const payload = getCryptoSendConfigPayload();
  const receive = buildReceiveNetworksPayload({ stellar, evm });
  const a = asset ? String(asset).toUpperCase() : null;
  return {
    assets: payload.assets,
    networks: (a
      ? receive.filter((n) => n.assets.map(String).includes(a))
      : receive
    ).filter((n) =>
      ['stellar', 'ethereum', 'bsc', 'arbitrum'].includes(n.key)
    ),
    topKeys: ['stellar', 'ethereum', 'bsc', 'arbitrum'],
    depositConfigured: {
      stellar: Boolean(stellar),
      evm: Boolean(evm),
    },
  };
}

function testCollectionInstructions(sequenceId: string): {
  accountName: string | null;
  accountNumber: string | null;
  bankName: string | null;
  reference: string;
  note?: string;
  expiresAt?: string;
} {
  return {
    accountName: 'Dayfi Collections',
    accountNumber: `9${String(Date.now()).slice(-9)}`,
    bankName: 'Dayfi',
    reference: `DAYFI-${sequenceId.slice(0, 8).toUpperCase()}`,
    note: 'Dayfi pay-in details — use Mark as paid to simulate settlement.',
  };
}

/**
 * Create a collection — Yellow Card preferred for local rails (multi-country).
 * Crypto path returns deposit network instructions (USDC/EURC).
 * TEST uses instant instructions when YC is unavailable (local IP not whitelisted).
 */
export async function createCollection(input: CreateCollectionInput) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  const fingerprint = fingerprintPayload({
    kind: 'collection',
    amount: persistMoney(amount),
    currency: String(input.currency || input.asset || 'NGN').toUpperCase(),
    country: String(input.country || 'NG').toUpperCase(),
    method: String(input.method || 'bank').toLowerCase(),
    asset: input.asset || null,
    network: input.network || null,
    channelId: input.channelId || null,
    customerEmail: input.customerEmail || null,
  });
  const replay = await findIdempotentTx(
    input.orgId,
    input.env,
    input.idempotencyKey,
    fingerprint
  );
  if (replay) {
    const meta = replay.metadata || {};
    const instructions = (meta.instructions || {}) as Record<string, unknown>;
    return {
      ...mapTx(replay),
      instructions,
      sequenceId: meta.sequenceId || replay.external_id,
      expiresAt: instructions.expiresAt,
      idempotentReplay: true,
    };
  }

  const sequenceId = crypto.randomUUID();
  const methodHint = String(input.method || 'bank').toLowerCase();
  const idem = {
    idempotencyKey: input.idempotencyKey,
    fingerprint,
  };

  // Crypto collect (USDC / EURC) — same idea as mobile receive wallets
  if (methodHint === 'crypto' || input.asset) {
    const asset = String(input.asset || input.currency || 'USDC').toUpperCase();
    const network = String(input.network || 'stellar').toLowerCase();
    const nets = listCryptoNetworks(asset);
    const net = nets.networks.find((n) => n.key === network) || nets.networks[0];
    if (!net) throw new Error(`No network available for ${asset}`);

    let address = String(input.depositAddress || net.address || '').trim();
    let placeholder = false;
    if (!address) {
      placeholder = true;
      address =
        net.rail === 'stellar'
          ? `GTEST${sequenceId.replace(/-/g, '').slice(0, 24).toUpperCase()}`
          : `0x${sequenceId.replace(/-/g, '').slice(0, 40)}`;
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const instructions = {
      asset,
      network: net.key,
      networkName: net.name,
      address,
      memo: sequenceId.slice(0, 8).toUpperCase(),
      expiresAt,
      note: placeholder
        ? 'Dayfi deposit address for this collection — Mark as paid to simulate settlement in TEST.'
        : 'Send only this asset on this network. Details expire in about 30 minutes.',
    };

    const row = await insertTx({
      orgId: input.orgId,
      env: input.env,
      amount,
      currency: asset,
      country: null,
      status: 'pending',
      method: 'crypto',
      direction: 'payment',
      externalId: sequenceId,
      metadata: {
        type: 'collection',
        rail: 'crypto',
        description: input.description || null,
        customerName: input.customerName || null,
        instructions,
        sequenceId,
      },
      ...idem,
    });

    return { ...mapTx(row), instructions, sequenceId, expiresAt };
  }

  const currency = String(input.currency || 'NGN').toUpperCase();
  const country = String(input.country || 'NG').toUpperCase();
  const method = methodHint === 'momo' ? 'mobile_money' : 'bank_transfer';
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const collectionMeta = (extra: Record<string, unknown>) => ({
    type: 'collection',
    rail: 'local',
    description: input.description || null,
    customerName: input.customerName || null,
    customerEmail: input.customerEmail || null,
    sequenceId,
    channelId: input.channelId || null,
    ...extra,
  });

  if (input.env !== 'live') {
    const instructions = {
      ...testCollectionInstructions(sequenceId),
      note: 'Dayfi TEST pay-in details — valid about 30 minutes. Mark as paid to simulate settlement.',
      expiresAt,
    };
    const row = await insertTx({
      orgId: input.orgId,
      env: input.env,
      amount,
      currency,
      country,
      status: 'pending',
      method,
      direction: 'payment',
      externalId: sequenceId,
      metadata: collectionMeta({
        instructions: { ...instructions, expiresAt },
        provider: null,
      }),
      ...idem,
    });
    return {
      ...mapTx(row),
      instructions: { ...instructions, expiresAt },
      sequenceId,
      expiresAt,
    };
  }

  const failLiveCollection = async (message: string): Promise<never> => {
    const row = await insertTx({
      orgId: input.orgId,
      env: input.env,
      amount,
      currency,
      country,
      status: 'failed',
      method,
      direction: 'payment',
      externalId: sequenceId,
      metadata: collectionMeta({
        instructions: null,
        provider: null,
        providerError: message,
      }),
      ...idem,
    });
    throw new InfraRailError(message, 502, row.id);
  };

  const yc = new YellowCardService();
  if (!yc.isConfigured()) {
    return failLiveCollection('Yellow Card is not configured for LIVE collections');
  }

  const ycParty = await resolveLiveYellowCardParty(input.orgId, country, {
    name: input.customerName,
  });

  try {
    const channelList = parseYellowCardChannelList(await yc.fetchChannels());
    const channel =
      (input.channelId
        ? channelList.find(
            (c) => String(c.id ?? c.channelId) === String(input.channelId)
          )
        : null) ||
      channelList.find(
        (c) =>
          String(c.country || '').toUpperCase() === country &&
          String(c.currency || c.localCurrency || '').toUpperCase() === currency &&
          String(c.rampType || c.ramp || '')
            .toLowerCase()
            .includes('deposit')
      ) ||
      channelList.find(
        (c) =>
          String(c.country || '').toUpperCase() === country &&
          String(c.currency || c.localCurrency || '').toUpperCase() === currency
      ) ||
      channelList[0];

    const channelId = String(input.channelId || channel?.id || channel?.channelId || '');
    if (!channelId) throw new Error('No collection channel available');

    const provider = await yc.createCollectionRequest({
      sequenceId,
      channelId,
      currency,
      country,
      reason: 'other',
      localAmount: amount,
      forceAccept: true,
      recipient: ycParty,
      source: {
        accountType: methodHint === 'momo' ? 'momo' : 'bank',
        accountNumber: '0000000000',
        networkId: String(channel?.networkId ?? channelId),
      },
    });

    const bankInfo =
      (provider as any)?.bankInfo ||
      (provider as any)?.data?.bankInfo ||
      (provider as any)?.destination ||
      null;
    const accountNumber = String(
      bankInfo?.accountNumber || bankInfo?.account_number || ''
    ).trim();
    if (!accountNumber) {
      throw new Error('Yellow Card did not return pay-in account details');
    }

    const instructions = {
      accountName: bankInfo.accountName || bankInfo.account_name || null,
      accountNumber,
      bankName: bankInfo.name || bankInfo.bankName || bankInfo.bank_name || null,
      reference: bankInfo.reference || sequenceId,
      note: 'Dayfi collection — complete payment within about 30 minutes.',
      expiresAt,
    };

    let status = String(
      (provider as any)?.status || (provider as any)?.data?.status || 'pending'
    ).toLowerCase();
    if (status === 'completed' || status === 'success') status = 'pending';

    const row = await insertTx({
      orgId: input.orgId,
      env: input.env,
      amount,
      currency,
      country,
      status: status || 'pending',
      method,
      direction: 'payment',
      externalId: sequenceId,
      metadata: collectionMeta({
        instructions: { ...instructions, expiresAt },
        provider,
      }),
      ...idem,
    });

    return {
      ...mapTx(row),
      instructions: { ...instructions, expiresAt },
      sequenceId,
      expiresAt,
    };
  } catch (err: any) {
    if (err instanceof InfraRailError) throw err;
    return failLiveCollection(err?.message || 'LIVE collection rail failed');
  }
}

/**
 * TEST-only: mark a pending/processing payment or payout as settled
 * and apply the Phase 2 ledger effect (collection credit / payout finalize).
 */

export async function simulateSettlement(input: {
  orgId: string;
  env: Env;
  transactionId: string;
}) {
  if (input.env !== 'test') {
    throw new Error('Simulate settlement is only available in TEST');
  }

  const row = await db.oneOrNone<{
    id: string;
    amount: string;
    currency: string;
    country: string | null;
    status: string;
    method: string;
    direction: string;
    fee: string;
    external_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id::text AS id, amount::text, currency, country, status, method, direction,
            fee::text, external_id, metadata, created_at
     FROM infra_transactions
     WHERE id = $1 AND org_id = $2 AND environment = 'test'`,
    [input.transactionId, input.orgId]
  );

  if (!row) {
    throw new Error('Transaction not found');
  }
  if (row.direction !== 'payment' && row.direction !== 'payout') {
    throw new Error('Only payments and payouts can be simulated');
  }
  if (['failed', 'cancelled', 'expired'].includes(String(row.status).toLowerCase())) {
    throw new Error(`Cannot settle a ${row.status} transaction`);
  }

  if (row.direction === 'payment') {
    const settled = await settleCollectionCredit({
      orgId: input.orgId,
      transactionId: row.id,
      providerEventId: `simulate:collection:${row.id}`,
      source: 'simulate',
    });
    const updated = await db.one<typeof row>(
      `SELECT id::text AS id, amount::text, currency, country, status, method, direction,
              fee::text, external_id, metadata, created_at
       FROM infra_transactions WHERE id = $1`,
      [row.id]
    );
    return {
      ...mapTx(updated),
      usdcAmount: settled.usdcAmount,
      balance: settled.balance,
      ledger: {
        creditId: settled.credit.id,
        duplicate: settled.credit.duplicate === true,
      },
      walletFunding: settled.walletFunding,
      ledgerPhase: settled.ledgerPhase,
    };
  }

  const settled = await finalizePayoutDebit({
    orgId: input.orgId,
    transactionId: row.id,
    providerEventId: `simulate:payout:${row.id}`,
    source: 'simulate',
  });
  const updated = await db.one<typeof row>(
    `SELECT id::text AS id, amount::text, currency, country, status, method, direction,
            fee::text, external_id, metadata, created_at
     FROM infra_transactions WHERE id = $1`,
    [row.id]
  );
  return {
    ...mapTx(updated),
    balance: settled.balance,
    ledger: {
      finalizeId: settled.finalize.id,
      duplicate: settled.finalize.duplicate === true,
    },
  };
}



/** Phase 2: lock org USDC after payout row is created. */
async function lockFundsForPayout(orgId: string, payoutId: string) {
  try {
    return await lockPayoutFunds({ orgId, transactionId: payoutId });
  } catch (err) {
    await db.none(
      `UPDATE infra_transactions
       SET status = 'failed',
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [
        payoutId,
        JSON.stringify({
          fundsLockFailed: true,
          fundsLockError: err instanceof Error ? err.message : String(err),
        }),
      ]
    );
    throw err;
  }
}

export async function createPayout(input: CreatePayoutInput) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  // Phase 3: resolve saved recipient → destination → payout fields
  let recipientMeta: Record<string, unknown> | null = null;
  let payoutInput: CreatePayoutInput = input;
  if (input.recipientId) {
    const resolvedDest = await resolveDestinationForPayout({
      orgId: input.orgId,
      environment: input.env,
      recipientId: input.recipientId,
      destinationId: input.destinationId,
    });
    const fields = destinationToPayoutFields(resolvedDest.destination);
    payoutInput = {
      ...input,
      accountType: fields.accountType,
      currency: input.currency || fields.currency,
      country: input.country || fields.country,
      accountNumber: fields.accountNumber || input.accountNumber,
      accountName: fields.accountName || input.accountName,
      bankCode: fields.bankCode || input.bankCode,
      bankName: fields.bankName || input.bankName,
      networkId: fields.networkId || input.networkId,
      asset: fields.asset || input.asset,
      network: fields.network || input.network,
      walletAddress: fields.walletAddress || input.walletAddress,
      dayfiTag: fields.dayfiTag || input.dayfiTag,
      recipientPhone: fields.recipientPhone || input.recipientPhone,
    };
    recipientMeta = {
      recipientId: resolvedDest.recipient.id,
      destinationId: resolvedDest.destination.id,
      recipientName: resolvedDest.recipient.displayName,
      rail: resolvedDest.destination.rail,
      displayHint: resolvedDest.destination.displayHint,
    };
  }

  const accountType = String(payoutInput.accountType || 'bank').toLowerCase();
  const fingerprint = fingerprintPayload({
    kind: 'payout',
    amount: persistMoney(amount),
    currency: String(payoutInput.currency || payoutInput.asset || 'NGN').toUpperCase(),
    country: String(payoutInput.country || 'NG').toUpperCase(),
    accountType,
    accountNumber: payoutInput.accountNumber || null,
    walletAddress: payoutInput.walletAddress || null,
    dayfiTag: payoutInput.dayfiTag || null,
    recipientId: payoutInput.recipientId || null,
    destinationId: payoutInput.destinationId || null,
    bulkItemId: payoutInput.bulkItemId || null,
  });
  const replay = await findIdempotentTx(
    payoutInput.orgId,
    payoutInput.env,
    payoutInput.idempotencyKey,
    fingerprint
  );
  if (replay) {
    const meta = replay.metadata || {};
    const balance = await getOrgBalance(payoutInput.orgId, payoutInput.env);
    return {
      ...mapTx(replay),
      sequenceId: meta.sequenceId || replay.external_id,
      usdcAmount: meta.usdcAmount,
      balance,
      fundsLocked: meta.fundsLocked === true,
      idempotentReplay: true,
      recipient: meta.recipient || meta.savedRecipient || null,
    };
  }

  const sequenceId = crypto.randomUUID();
  const idem = {
    idempotencyKey: payoutInput.idempotencyKey,
    fingerprint,
  };
  const bulkMeta =
    payoutInput.bulkBatchId || payoutInput.bulkItemId
      ? {
          bulk: {
            batchId: payoutInput.bulkBatchId || null,
            itemId: payoutInput.bulkItemId || null,
          },
        }
      : null;

  if (accountType === 'dayfi_tag' || payoutInput.dayfiTag) {
    const rawTag = String(payoutInput.dayfiTag || payoutInput.accountNumber || '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase();
    if (!rawTag) throw new Error('Dayfi tag is required');

    const recipient = await db.oneOrNone<{
      id: string;
      dayfi_tag: string;
      name: string | null;
      org_id: string | null;
    }>(
      `SELECT id, dayfi_tag, name, org_id FROM infra_members
       WHERE LOWER(dayfi_tag) = LOWER($1) LIMIT 1`,
      [rawTag]
    );
    if (!recipient) throw new Error('No Dayfi user found with that tag');

    const currency = String(payoutInput.currency || 'NGN').toUpperCase();
    const row = await insertTx({
      orgId: payoutInput.orgId,
      env: payoutInput.env,
      amount,
      currency,
      country: String(payoutInput.country || 'NG').toUpperCase(),
      status: payoutInput.env === 'test' ? 'processing' : 'pending',
      method: 'dayfi_tag',
      direction: 'payout',
      externalId: sequenceId,
      metadata: {
        type: 'payout',
        rail: 'dayfi_tag',
        recipient: {
          dayfiTag: recipient.dayfi_tag,
          accountName: recipient.name || `@${recipient.dayfi_tag}`,
          memberId: recipient.id,
          orgId: recipient.org_id,
        },
        sequenceId,
        ...(recipientMeta ? { savedRecipient: recipientMeta } : {}),
        ...(bulkMeta || {}),
      },
      ...idem,
    });

    const locked = await lockFundsForPayout(payoutInput.orgId, row.id);
    return {
      ...mapTx(row),
      sequenceId,
      usdcAmount: locked.usdcAmount,
      balance: locked.balance,
      fundsLocked: true,
      recipient: {
        dayfiTag: recipient.dayfi_tag,
        accountName: recipient.name || `@${recipient.dayfi_tag}`,
        accountType: 'dayfi_tag',
      },
    };
  }

  if (accountType === 'crypto' || payoutInput.asset) {
    const asset = String(payoutInput.asset || payoutInput.currency || 'USDC').toUpperCase();
    const network = String(payoutInput.network || 'stellar').toLowerCase();
    const walletAddress = String(payoutInput.walletAddress || payoutInput.accountNumber || '').trim();
    if (!walletAddress) throw new Error('Wallet address is required');

    const row = await insertTx({
      orgId: payoutInput.orgId,
      env: payoutInput.env,
      amount,
      currency: asset,
      country: null,
      status: payoutInput.env === 'test' ? 'processing' : 'pending',
      method: 'crypto',
      direction: 'payout',
      externalId: sequenceId,
      metadata: {
        type: 'payout',
        rail: 'crypto',
        recipient: {
          asset,
          network,
          walletAddress,
          accountName: payoutInput.accountName || (recipientMeta ? null : walletAddress),
          ...(recipientMeta
            ? { displayHint: recipientMeta.displayHint }
            : {}),
        },
        sequenceId,
        ...(recipientMeta ? { savedRecipient: recipientMeta } : {}),
        ...(bulkMeta || {}),
      },
      ...idem,
    });

    const locked = await lockFundsForPayout(payoutInput.orgId, row.id);
    return {
      ...mapTx(row),
      sequenceId,
      usdcAmount: locked.usdcAmount,
      balance: locked.balance,
      fundsLocked: true,
      recipient: recipientMeta
        ? {
            asset,
            network,
            displayHint: recipientMeta.displayHint,
            recipientId: recipientMeta.recipientId,
            destinationId: recipientMeta.destinationId,
          }
        : { asset, network, walletAddress },
    };
  }

  const currency = String(payoutInput.currency || 'NGN').toUpperCase();
  const country = String(payoutInput.country || 'NG').toUpperCase();
  if (!payoutInput.accountNumber?.trim() || !payoutInput.accountName?.trim()) {
    throw new Error('Account number and account name are required');
  }
  if (accountType === 'bank' && !payoutInput.bankCode?.trim()) {
    throw new Error('Bank / network is required');
  }

  let resolvedName = payoutInput.accountName.trim();
  if (payoutInput.env === 'live' && accountType === 'bank' && payoutInput.bankCode) {
    try {
      const resolved = await resolveBank(payoutInput.accountNumber, payoutInput.bankCode);
      if (resolved.accountName) resolvedName = resolved.accountName;
    } catch (err) {
      if (payoutInput.env === 'live') throw err;
    }
  }

  const method = accountType === 'momo' ? 'mobile_money' : 'bank_transfer';
  const destType = accountType === 'momo' ? 'momo' : 'bank';
  const payoutMetadata = {
    type: 'payout',
    accountType: destType,
    recipient: recipientMeta
      ? {
          accountName: resolvedName,
          bankCode: payoutInput.bankCode || null,
          bankName: payoutInput.bankName || null,
          displayHint: recipientMeta.displayHint,
        }
      : {
          accountNumber: payoutInput.accountNumber.trim(),
          accountName: resolvedName,
          bankCode: payoutInput.bankCode || null,
          bankName: payoutInput.bankName || null,
        },
    reason: payoutInput.reason || 'other',
    provider: null as Record<string, unknown> | null,
    sequenceId,
    channelId: payoutInput.channelId || null,
    ...(recipientMeta ? { savedRecipient: recipientMeta } : {}),
    ...(bulkMeta || {}),
  };

  if (payoutInput.env === 'live') {
    const ycReady = new YellowCardService();
    if (!ycReady.isConfigured()) {
      const failed = await insertTx({
        orgId: payoutInput.orgId,
        env: payoutInput.env,
        amount,
        currency,
        country,
        status: 'failed',
        method,
        direction: 'payout',
        externalId: sequenceId,
        metadata: {
          ...payoutMetadata,
          providerError: 'Yellow Card is not configured for LIVE payouts',
        },
        ...idem,
      });
      throw new InfraRailError(
        'Yellow Card is not configured for LIVE payouts',
        502,
        failed.id
      );
    }
  }

  let ycParty: YcParty | null = null;
  if (payoutInput.env === 'live') {
    ycParty = await resolveLiveYellowCardParty(payoutInput.orgId, country, {
      name: resolvedName,
      phone: payoutInput.recipientPhone,
      email: payoutInput.recipientEmail,
    });
  }

  const row = await insertTx({
    orgId: payoutInput.orgId,
    env: payoutInput.env,
    amount,
    currency,
    country,
    status: payoutInput.env === 'live' ? 'pending' : 'processing',
    method,
    direction: 'payout',
    externalId: sequenceId,
    metadata: payoutMetadata,
    ...idem,
  });

  const locked = await lockFundsForPayout(payoutInput.orgId, row.id);

  const offrampEnabled = (() => {
    try {
      // Lazy require avoids circular deps with withdrawal service.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isFiatOfframpEnabled } = require('./infraFiatWithdrawalService');
      return isFiatOfframpEnabled() === true;
    } catch {
      return false;
    }
  })();

  if (offrampEnabled) {
    await db.none(
      `UPDATE infra_transactions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [
        row.id,
        JSON.stringify({
          offRamp: true,
          offRampPhase: 'locked',
          settlementMode: 'STELLAR_TREASURY',
          providerDeferred: true,
        }),
      ]
    );
    const latestOfframp = await fetchTxRow(row.id);
    return {
      ...mapTx(latestOfframp),
      sequenceId,
      usdcAmount: locked.usdcAmount,
      balance: locked.balance,
      fundsLocked: true,
      offRamp: true,
      offRampPhase: 'locked',
      recipient: recipientMeta
        ? {
            accountName: resolvedName,
            bankCode: payoutInput.bankCode || null,
            bankName: payoutInput.bankName || null,
            accountType: destType,
            displayHint: recipientMeta.displayHint,
            recipientId: recipientMeta.recipientId,
            destinationId: recipientMeta.destinationId,
          }
        : {
            accountNumber: payoutInput.accountNumber.trim(),
            accountName: resolvedName,
            bankCode: payoutInput.bankCode || null,
            bankName: payoutInput.bankName || null,
            accountType: destType,
          },
    };
  }

  if (payoutInput.env === 'live') {
    try {
      const yc = new YellowCardService();
      const channelList = parseYellowCardChannelList(await yc.fetchChannels());
      const channelId =
        payoutInput.channelId ||
        String(
          channelList.find(
            (c) =>
              String(c.country || '').toUpperCase() === country &&
              String(c.currency || c.localCurrency || '').toUpperCase() === currency
          )?.id ??
            channelList[0]?.id ??
            channelList[0]?.channelId ??
            ''
        );
      if (!channelId) throw new Error('No payout channel available');
      if (!ycParty) {
        throw new InfraRailError(
          'LIVE Yellow Card requires real KYC on the organization',
          400
        );
      }
      const networkId = payoutInput.networkId || payoutInput.bankCode;

      const provider = await yc.createPaymentRequest({
        sequenceId,
        channelId,
        currency,
        country,
        reason: String(payoutInput.reason || 'other').toLowerCase(),
        amount,
        forceAccept: true,
        destination: {
          accountNumber: payoutInput.accountNumber.trim(),
          accountType: destType,
          networkId,
          accountName: resolvedName,
        },
        recipient: ycParty,
      });

      await db.none(
        `UPDATE infra_transactions
         SET status = 'processing',
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [
          row.id,
          JSON.stringify({
            provider,
            railSubmittedAt: new Date().toISOString(),
          }),
        ]
      );
    } catch (err: any) {
      try {
        await releasePayoutLock({
          orgId: payoutInput.orgId,
          transactionId: row.id,
          source: 'yellowcard_submit_failed',
          status: 'failed',
        });
      } catch (releaseErr) {
        console.error(
          '[infra-money] failed to release lock after YC payout submit error',
          releaseErr
        );
      }
      throw new InfraRailError(
        err?.message || 'LIVE payout rail failed',
        502,
        row.id
      );
    }
  }

  const latest = await fetchTxRow(row.id);
  return {
    ...mapTx(latest),
    sequenceId,
    usdcAmount: locked.usdcAmount,
    balance: locked.balance,
    fundsLocked: true,
    recipient: recipientMeta
      ? {
          accountName: resolvedName,
          bankCode: payoutInput.bankCode || null,
          bankName: payoutInput.bankName || null,
          accountType: destType,
          displayHint: recipientMeta.displayHint,
          recipientId: recipientMeta.recipientId,
          destinationId: recipientMeta.destinationId,
        }
      : {
          accountNumber: payoutInput.accountNumber.trim(),
          accountName: resolvedName,
          bankCode: payoutInput.bankCode || null,
          bankName: payoutInput.bankName || null,
          accountType: destType,
        },
  };
}
