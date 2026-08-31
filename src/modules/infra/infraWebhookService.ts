import crypto from 'crypto';
import { db } from '../../config/database';
import { hashApiKey, type InfraAuth } from './infraService';

const DEFAULT_EVENTS = ['*'];
const ALLOWED_EVENTS = new Set([
  '*',
  'payment.pending',
  'payment.processing',
  'payment.completed',
  'payment.failed',
  'payout.pending',
  'payout.completed',
  'payout.failed',
  'settlement.created',
]);

type WebhookEnv = 'test' | 'live';

type EndpointRow = {
  id: string;
  org_id: string;
  environment: WebhookEnv;
  label: string;
  url: string;
  secret_prefix: string;
  secret_last_four: string;
  events: string[] | unknown;
  status: string;
  created_at: Date;
  revoked_at: Date | null;
  created_by_email: string | null;
};

function generateWebhookSecret(env: WebhookEnv): {
  secret: string;
  prefix: string;
  lastFour: string;
} {
  const prefix = env === 'live' ? 'whsec_live_' : 'whsec_test_';
  const body = crypto.randomBytes(24).toString('hex');
  const secret = `${prefix}${body}`;
  return { secret, prefix, lastFour: body.slice(-4) };
}

export function validateWebhookUrl(url: string, env: WebhookEnv): string {
  const trimmed = String(url || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Object.assign(new Error('Webhook URL must be a valid HTTPS URL'), { status: 400 });
  }
  if (env === 'test' && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    return trimmed;
  }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Webhook URL must use HTTPS (http://localhost allowed in TEST only)'), {
      status: 400,
    });
  }
  return trimmed;
}

function normalizeEvents(raw: unknown): string[] {
  if (!raw) return DEFAULT_EVENTS;
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const cleaned = list.map((e) => e.trim()).filter(Boolean);
  if (cleaned.length === 0) return DEFAULT_EVENTS;
  for (const event of cleaned) {
    if (!ALLOWED_EVENTS.has(event)) {
      throw Object.assign(new Error(`Unsupported event type: ${event}`), { status: 400 });
    }
  }
  return cleaned;
}

function serializeEndpoint(row: EndpointRow) {
  const events = Array.isArray(row.events) ? row.events : DEFAULT_EVENTS;
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    environment: row.environment,
    events,
    status: row.status,
    secretPreview: `${row.secret_prefix}••••${row.secret_last_four}`,
    createdAt: row.created_at,
    createdBy: row.created_by_email,
  };
}

export async function listWebhookEndpoints(orgId: string, env: WebhookEnv) {
  const rows = await db.manyOrNone<EndpointRow>(
    `SELECT e.id, e.org_id, e.environment, e.label, e.url, e.secret_prefix, e.secret_last_four,
            e.events, e.status, e.created_at, e.revoked_at, m.email AS created_by_email
     FROM infra_webhook_endpoints e
     LEFT JOIN infra_members m ON m.id = e.created_by
     WHERE e.org_id = $1 AND e.environment = $2 AND e.revoked_at IS NULL
     ORDER BY e.created_at DESC`,
    [orgId, env]
  );
  return rows.map(serializeEndpoint);
}

export async function createWebhookEndpoint(
  orgId: string,
  env: WebhookEnv,
  input: { label?: string; url: string; events?: unknown },
  actor: InfraAuth
) {
  const url = validateWebhookUrl(input.url, env);
  const label = String(input.label || 'Webhook endpoint').trim() || 'Webhook endpoint';
  const events = normalizeEvents(input.events);
  const { secret, prefix, lastFour } = generateWebhookSecret(env);

  const row = await db.one<EndpointRow>(
    `INSERT INTO infra_webhook_endpoints
       (org_id, environment, label, url, secret_hash, secret_prefix, secret_last_four, events, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id, org_id, environment, label, url, secret_prefix, secret_last_four,
               events, status, created_at, revoked_at,
               (SELECT email FROM infra_members WHERE id = $9) AS created_by_email`,
    [orgId, env, label, url, hashApiKey(secret), prefix, lastFour, JSON.stringify(events), actor.memberId]
  );

  return {
    ...serializeEndpoint(row),
    secret,
  };
}

export async function revokeWebhookEndpoint(
  orgId: string,
  env: WebhookEnv,
  endpointId: string
): Promise<boolean> {
  const result = await db.result(
    `UPDATE infra_webhook_endpoints
     SET revoked_at = NOW(), updated_at = NOW(), status = 'disabled'
     WHERE id = $1 AND org_id = $2 AND environment = $3 AND revoked_at IS NULL`,
    [endpointId, orgId, env]
  );
  return result.rowCount > 0;
}

export async function listWebhookDeliveries(orgId: string, env: WebhookEnv, limit = 50) {
  const rows = await db.manyOrNone<{
    id: string;
    endpoint_id: string;
    event_type: string;
    resource_type: string | null;
    resource_id: string | null;
    status: string;
    attempt_count: number;
    http_status: number | null;
    error_message: string | null;
    created_at: Date;
    delivered_at: Date | null;
    endpoint_label: string;
    endpoint_url: string;
  }>(
    `SELECT d.id, d.endpoint_id, d.event_type, d.resource_type, d.resource_id, d.status,
            d.attempt_count, d.http_status, d.error_message, d.created_at, d.delivered_at,
            e.label AS endpoint_label, e.url AS endpoint_url
     FROM infra_webhook_deliveries d
     JOIN infra_webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.org_id = $1 AND d.environment = $2
     ORDER BY d.created_at DESC
     LIMIT $3`,
    [orgId, env, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    endpointId: r.endpoint_id,
    endpointLabel: r.endpoint_label,
    endpointUrl: r.endpoint_url,
    eventType: r.event_type,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    status: r.status,
    attemptCount: r.attempt_count,
    httpStatus: r.http_status,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  }));
}

export async function listAdminWebhookEndpoints(query: {
  search?: string;
  orgId?: string;
  environment?: string;
  limit?: number;
  offset?: number;
}) {
  const params: unknown[] = [];
  const where: string[] = ['e.revoked_at IS NULL'];

  if (query.orgId) {
    params.push(query.orgId);
    where.push(`e.org_id = $${params.length}`);
  }
  if (query.environment && query.environment !== 'ALL') {
    params.push(query.environment === 'live' ? 'live' : 'test');
    where.push(`e.environment = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search.trim()}%`);
    where.push(
      `(e.label ILIKE $${params.length} OR e.url ILIKE $${params.length} OR o.name ILIKE $${params.length})`
    );
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  params.push(limit, offset);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const totalRow = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM infra_webhook_endpoints e
     JOIN infra_organizations o ON o.id = e.org_id
     ${whereSql}`,
    params.slice(0, -2)
  );

  const rows = await db.manyOrNone<{
    id: string;
    org_id: string;
    org_name: string;
    environment: WebhookEnv;
    label: string;
    url: string;
    status: string;
    events: string[] | unknown;
    created_at: Date;
  }>(
    `SELECT e.id, e.org_id, o.name AS org_name, e.environment, e.label, e.url, e.status, e.events, e.created_at
     FROM infra_webhook_endpoints e
     JOIN infra_organizations o ON o.id = e.org_id
     ${whereSql}
     ORDER BY e.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return {
    items: rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      environment: r.environment,
      label: r.label,
      url: r.url,
      status: r.status,
      events: Array.isArray(r.events) ? r.events : DEFAULT_EVENTS,
      createdAt: r.created_at,
    })),
    total: totalRow.n,
    limit,
    offset,
  };
}
