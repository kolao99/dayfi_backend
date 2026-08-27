/**
 * Phase 3 — Infrastructure recipients (rail-agnostic).
 *
 * Contract:
 *   Recipient   = who is paid (person/business), always org-scoped
 *   Destination = how Dayfi reaches them (rail + country + currency + payload)
 *
 * Sensitive `destination_data` is for payout execution only and is never returned
 * by list/read APIs — only `displayHint` / `lastFour`.
 */

import { db } from '../../config/database';

export type InfraEnv = 'test' | 'live';
export type DestinationRail = 'bank' | 'mobile_money' | 'crypto' | 'dayfi';
export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'failed';

export class InfraRecipientError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'InfraRecipientError';
    this.code = code;
    this.status = status;
  }
}

export type DestinationData = {
  accountNumber?: string;
  accountName?: string;
  bankCode?: string;
  bankName?: string;
  phone?: string;
  networkId?: string;
  walletAddress?: string;
  network?: string;
  asset?: string;
  dayfiTag?: string;
  [key: string]: unknown;
};

export type CreateDestinationInput = {
  rail: DestinationRail | string;
  country?: string;
  currency?: string;
  provider?: string;
  label?: string;
  isDefault?: boolean;
  verificationStatus?: VerificationStatus;
  destinationData: DestinationData;
};

export type CreateRecipientInput = {
  orgId: string;
  environment: InfraEnv | string;
  displayName: string;
  country?: string;
  email?: string;
  phone?: string;
  metadata?: Record<string, unknown>;
  destination?: CreateDestinationInput;
};

type RecipientRow = {
  id: string;
  org_id: string;
  environment: string;
  display_name: string;
  country: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type DestinationRow = {
  id: string;
  recipient_id: string;
  org_id: string;
  environment: string;
  rail: string;
  country: string | null;
  currency: string | null;
  provider: string | null;
  label: string | null;
  display_hint: string;
  last_four: string | null;
  verification_status: string;
  destination_data: DestinationData;
  is_default: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
};

function asEnv(env: string): InfraEnv {
  return env === 'live' ? 'live' : 'test';
}

export function normalizeRail(raw: string): DestinationRail {
  const r = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (r === 'bank' || r === 'bank_transfer') return 'bank';
  if (r === 'mobile_money' || r === 'momo' || r === 'mobilemoney') return 'mobile_money';
  if (r === 'crypto' || r === 'stellar' || r === 'usdc') return 'crypto';
  if (r === 'dayfi' || r === 'dayfi_tag' || r === 'tag') return 'dayfi';
  throw new InfraRecipientError(`Unsupported rail: ${raw}`, 'INVALID_RAIL');
}

/** Build last-four + display hint; never expose full account/wallet in APIs. */
export function maskDestination(
  rail: DestinationRail,
  data: DestinationData,
  provider?: string | null
): { lastFour: string | null; displayHint: string } {
  if (rail === 'bank') {
    const acct = String(data.accountNumber || '').replace(/\s+/g, '');
    const lastFour = acct.slice(-4) || null;
    const bank = provider || data.bankName || 'Bank';
    return {
      lastFour,
      displayHint: lastFour ? `${bank} ···· ${lastFour}` : String(bank),
    };
  }
  if (rail === 'mobile_money') {
    const phone = String(data.phone || data.accountNumber || '').replace(/\s+/g, '');
    const lastFour = phone.slice(-4) || null;
    const net = provider || data.bankName || 'Mobile Money';
    return {
      lastFour,
      displayHint: lastFour ? `${net} ···· ${lastFour}` : String(net),
    };
  }
  if (rail === 'crypto') {
    const addr = String(data.walletAddress || data.accountNumber || '').trim();
    const lastFour = addr.slice(-4).toUpperCase() || null;
    const asset = String(data.asset || 'USDC').toUpperCase();
    const network = String(data.network || provider || 'stellar');
    return {
      lastFour,
      displayHint: lastFour
        ? `${asset} · ${network} ····${lastFour}`
        : `${asset} · ${network}`,
    };
  }
  const tag = String(data.dayfiTag || data.accountNumber || '')
    .replace(/^@+/, '')
    .toLowerCase();
  return {
    lastFour: tag ? tag.slice(-4) : null,
    displayHint: tag ? `@${tag}` : 'Dayfi tag',
  };
}

function validateDestinationData(rail: DestinationRail, data: DestinationData): void {
  if (rail === 'bank') {
    if (!String(data.accountNumber || '').trim()) {
      throw new InfraRecipientError('accountNumber is required for bank', 'INVALID_DESTINATION');
    }
    if (!String(data.accountName || '').trim()) {
      throw new InfraRecipientError('accountName is required for bank', 'INVALID_DESTINATION');
    }
    if (!String(data.bankCode || '').trim()) {
      throw new InfraRecipientError('bankCode is required for bank', 'INVALID_DESTINATION');
    }
  } else if (rail === 'mobile_money') {
    if (!String(data.phone || data.accountNumber || '').trim()) {
      throw new InfraRecipientError(
        'phone / accountNumber is required for mobile_money',
        'INVALID_DESTINATION'
      );
    }
  } else if (rail === 'crypto') {
    if (!String(data.walletAddress || data.accountNumber || '').trim()) {
      throw new InfraRecipientError(
        'walletAddress is required for crypto',
        'INVALID_DESTINATION'
      );
    }
  } else if (rail === 'dayfi') {
    if (!String(data.dayfiTag || data.accountNumber || '').trim()) {
      throw new InfraRecipientError('dayfiTag is required for dayfi rail', 'INVALID_DESTINATION');
    }
  }
}

function mapRecipient(row: RecipientRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    environment: row.environment,
    displayName: row.display_name,
    country: row.country,
    email: row.email,
    phone: row.phone,
    status: row.status,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDestinationPublic(row: DestinationRow) {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    orgId: row.org_id,
    environment: row.environment,
    rail: row.rail,
    country: row.country,
    currency: row.currency,
    provider: row.provider,
    label: row.label,
    displayHint: row.display_hint,
    lastFour: row.last_four,
    verificationStatus: row.verification_status,
    isDefault: row.is_default,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createRecipient(input: CreateRecipientInput) {
  const env = asEnv(String(input.environment));
  const displayName = String(input.displayName || '').trim();
  if (displayName.length < 2) {
    throw new InfraRecipientError('displayName is required', 'INVALID_NAME');
  }

  const recipient = await db.one<RecipientRow>(
    `INSERT INTO infra_recipients
       (org_id, environment, display_name, country, email, phone, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id::text AS id, org_id::text AS org_id, environment, display_name, country,
               email, phone, status, metadata, created_at, updated_at`,
    [
      input.orgId,
      env,
      displayName,
      input.country ? String(input.country).toUpperCase() : null,
      input.email || null,
      input.phone || null,
      JSON.stringify(input.metadata || {}),
    ]
  );

  let destination = null;
  if (input.destination) {
    destination = await addDestination(input.orgId, recipient.id, env, {
      ...input.destination,
      isDefault: input.destination.isDefault !== false,
    });
  }

  return {
    ...mapRecipient(recipient),
    destinations: destination ? [destination] : [],
  };
}

export async function listRecipients(
  orgId: string,
  environment: InfraEnv | string,
  opts?: { q?: string; includeArchived?: boolean }
) {
  const env = asEnv(String(environment));
  const q = String(opts?.q || '').trim();
  const rows = await db.manyOrNone<RecipientRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, display_name, country,
            email, phone, status, metadata, created_at, updated_at
     FROM infra_recipients
     WHERE org_id = $1 AND environment = $2
       AND ($3::boolean OR status = 'active')
       AND ($4 = '' OR display_name ILIKE '%' || $4 || '%' OR COALESCE(email,'') ILIKE '%' || $4 || '%')
     ORDER BY display_name ASC, created_at DESC
     LIMIT 200`,
    [orgId, env, Boolean(opts?.includeArchived), q]
  );

  const result = [];
  for (const row of rows) {
    const destinations = await listDestinationsPublic(orgId, row.id);
    result.push({ ...mapRecipient(row), destinations });
  }
  return result;
}

export async function getRecipient(
  orgId: string,
  recipientId: string,
  environment?: InfraEnv | string
) {
  const row = await db.oneOrNone<RecipientRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, display_name, country,
            email, phone, status, metadata, created_at, updated_at
     FROM infra_recipients
     WHERE id = $1 AND org_id = $2
       AND ($3::text IS NULL OR environment = $3)`,
    [recipientId, orgId, environment ? asEnv(String(environment)) : null]
  );
  if (!row) {
    throw new InfraRecipientError('Recipient not found', 'NOT_FOUND', 404);
  }
  const destinations = await listDestinationsPublic(orgId, row.id);
  return { ...mapRecipient(row), destinations };
}

export async function updateRecipient(
  orgId: string,
  recipientId: string,
  patch: {
    displayName?: string;
    country?: string;
    email?: string | null;
    phone?: string | null;
    status?: 'active' | 'archived';
    metadata?: Record<string, unknown>;
  }
) {
  await getRecipient(orgId, recipientId);
  const row = await db.one<RecipientRow>(
    `UPDATE infra_recipients SET
       display_name = COALESCE($3, display_name),
       country = COALESCE($4, country),
       email = CASE WHEN $5::boolean THEN $6 ELSE email END,
       phone = CASE WHEN $7::boolean THEN $8 ELSE phone END,
       status = COALESCE($9, status),
       metadata = CASE WHEN $10::boolean THEN $11::jsonb ELSE metadata END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND org_id = $2
     RETURNING id::text AS id, org_id::text AS org_id, environment, display_name, country,
               email, phone, status, metadata, created_at, updated_at`,
    [
      recipientId,
      orgId,
      patch.displayName != null ? String(patch.displayName).trim() : null,
      patch.country != null ? String(patch.country).toUpperCase() : null,
      patch.email !== undefined,
      patch.email ?? null,
      patch.phone !== undefined,
      patch.phone ?? null,
      patch.status || null,
      patch.metadata !== undefined,
      JSON.stringify(patch.metadata || {}),
    ]
  );
  const destinations = await listDestinationsPublic(orgId, row.id);
  return { ...mapRecipient(row), destinations };
}

export async function archiveRecipient(orgId: string, recipientId: string) {
  return updateRecipient(orgId, recipientId, { status: 'archived' });
}

async function listDestinationsPublic(orgId: string, recipientId: string) {
  const rows = await db.manyOrNone<DestinationRow>(
    `SELECT id::text AS id, recipient_id::text AS recipient_id, org_id::text AS org_id,
            environment, rail, country, currency, provider, label, display_hint, last_four,
            verification_status, destination_data, is_default, status, created_at, updated_at
     FROM infra_recipient_destinations
     WHERE org_id = $1 AND recipient_id = $2 AND status = 'active'
     ORDER BY is_default DESC, created_at ASC`,
    [orgId, recipientId]
  );
  return rows.map(mapDestinationPublic);
}

export async function addDestination(
  orgId: string,
  recipientId: string,
  environment: InfraEnv | string,
  input: CreateDestinationInput
) {
  const env = asEnv(String(environment));
  const recipient = await getRecipient(orgId, recipientId, env);
  const rail = normalizeRail(String(input.rail));
  const data = { ...(input.destinationData || {}) };
  validateDestinationData(rail, data);
  const { lastFour, displayHint } = maskDestination(rail, data, input.provider);

  if (input.isDefault) {
    await db.none(
      `UPDATE infra_recipient_destinations
       SET is_default = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE recipient_id = $1 AND org_id = $2 AND is_default = TRUE`,
      [recipientId, orgId]
    );
  }

  const row = await db.one<DestinationRow>(
    `INSERT INTO infra_recipient_destinations
       (recipient_id, org_id, environment, rail, country, currency, provider, label,
        display_hint, last_four, verification_status, destination_data, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
     RETURNING id::text AS id, recipient_id::text AS recipient_id, org_id::text AS org_id,
               environment, rail, country, currency, provider, label, display_hint, last_four,
               verification_status, destination_data, is_default, status, created_at, updated_at`,
    [
      recipientId,
      orgId,
      env,
      rail,
      input.country ? String(input.country).toUpperCase() : recipient.country || null,
      input.currency ? String(input.currency).toUpperCase() : null,
      input.provider || null,
      input.label || null,
      displayHint,
      lastFour,
      input.verificationStatus || 'unverified',
      JSON.stringify(data),
      Boolean(input.isDefault),
    ]
  );

  return mapDestinationPublic(row);
}

export async function archiveDestination(
  orgId: string,
  destinationId: string
) {
  const row = await db.oneOrNone<DestinationRow>(
    `UPDATE infra_recipient_destinations
     SET status = 'archived', is_default = FALSE, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND org_id = $2 AND status = 'active'
     RETURNING id::text AS id, recipient_id::text AS recipient_id, org_id::text AS org_id,
               environment, rail, country, currency, provider, label, display_hint, last_four,
               verification_status, destination_data, is_default, status, created_at, updated_at`,
    [destinationId, orgId]
  );
  if (!row) {
    throw new InfraRecipientError('Destination not found', 'NOT_FOUND', 404);
  }
  return mapDestinationPublic(row);
}

/**
 * Resolve a destination for payout execution (includes secrets).
 * Always org-scoped — never cross-org.
 */
export async function resolveDestinationForPayout(input: {
  orgId: string;
  environment: InfraEnv | string;
  recipientId: string;
  destinationId?: string;
}): Promise<{
  recipient: ReturnType<typeof mapRecipient>;
  destination: ReturnType<typeof mapDestinationPublic> & {
    destinationData: DestinationData;
  };
}> {
  const env = asEnv(String(input.environment));
  const recipientRow = await db.oneOrNone<RecipientRow>(
    `SELECT id::text AS id, org_id::text AS org_id, environment, display_name, country,
            email, phone, status, metadata, created_at, updated_at
     FROM infra_recipients
     WHERE id = $1 AND org_id = $2 AND environment = $3 AND status = 'active'`,
    [input.recipientId, input.orgId, env]
  );
  if (!recipientRow) {
    throw new InfraRecipientError('Recipient not found', 'NOT_FOUND', 404);
  }

  let dest: DestinationRow | null = null;
  if (input.destinationId) {
    dest = await db.oneOrNone<DestinationRow>(
      `SELECT id::text AS id, recipient_id::text AS recipient_id, org_id::text AS org_id,
              environment, rail, country, currency, provider, label, display_hint, last_four,
              verification_status, destination_data, is_default, status, created_at, updated_at
       FROM infra_recipient_destinations
       WHERE id = $1 AND recipient_id = $2 AND org_id = $3 AND status = 'active'`,
      [input.destinationId, input.recipientId, input.orgId]
    );
  } else {
    dest = await db.oneOrNone<DestinationRow>(
      `SELECT id::text AS id, recipient_id::text AS recipient_id, org_id::text AS org_id,
              environment, rail, country, currency, provider, label, display_hint, last_four,
              verification_status, destination_data, is_default, status, created_at, updated_at
       FROM infra_recipient_destinations
       WHERE recipient_id = $1 AND org_id = $2 AND status = 'active'
       ORDER BY is_default DESC, created_at ASC
       LIMIT 1`,
      [input.recipientId, input.orgId]
    );
  }

  if (!dest) {
    throw new InfraRecipientError('No active destination for recipient', 'NO_DESTINATION', 400);
  }

  return {
    recipient: mapRecipient(recipientRow),
    destination: {
      ...mapDestinationPublic(dest),
      destinationData: dest.destination_data || {},
    },
  };
}

/** Map a destination into CreatePayoutInput fields (Phase 2 Send). */
export function destinationToPayoutFields(dest: {
  rail: string;
  country: string | null;
  currency: string | null;
  provider: string | null;
  destinationData: DestinationData;
}): {
  accountType: string;
  currency?: string;
  country?: string;
  accountNumber?: string;
  accountName?: string;
  bankCode?: string;
  bankName?: string;
  networkId?: string;
  asset?: string;
  network?: string;
  walletAddress?: string;
  dayfiTag?: string;
  recipientPhone?: string;
} {
  const data = dest.destinationData || {};
  const rail = normalizeRail(dest.rail);

  if (rail === 'bank') {
    return {
      accountType: 'bank',
      currency: dest.currency || undefined,
      country: dest.country || undefined,
      accountNumber: String(data.accountNumber || ''),
      accountName: String(data.accountName || ''),
      bankCode: String(data.bankCode || ''),
      bankName: String(data.bankName || dest.provider || ''),
    };
  }
  if (rail === 'mobile_money') {
    return {
      accountType: 'momo',
      currency: dest.currency || undefined,
      country: dest.country || undefined,
      accountNumber: String(data.phone || data.accountNumber || ''),
      accountName: String(data.accountName || ''),
      bankCode: String(data.networkId || data.bankCode || ''),
      bankName: String(dest.provider || data.bankName || ''),
      networkId: String(data.networkId || data.bankCode || ''),
      recipientPhone: String(data.phone || data.accountNumber || ''),
    };
  }
  if (rail === 'crypto') {
    return {
      accountType: 'crypto',
      currency: String(data.asset || dest.currency || 'USDC'),
      asset: String(data.asset || dest.currency || 'USDC'),
      network: String(data.network || 'stellar'),
      walletAddress: String(data.walletAddress || data.accountNumber || ''),
      accountName: String(data.accountName || ''),
    };
  }
  return {
    accountType: 'dayfi_tag',
    currency: dest.currency || undefined,
    country: dest.country || undefined,
    dayfiTag: String(data.dayfiTag || data.accountNumber || '').replace(/^@+/, ''),
    accountName: String(data.accountName || ''),
  };
}
