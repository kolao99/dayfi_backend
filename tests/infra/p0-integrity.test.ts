/**
 * P0 money-integrity proofs:
 * 1. Hashed API-key Bearer auth (real HTTP GET /balance)
 * 2. LIVE Collect never invents pay-in details / never credits on rail failure
 * 3. LIVE Send lock → YC fail → release (idempotent)
 * 4. Yellow Card webhook HMAC before any ledger write
 *
 * Run: npm run test:infra-p0
 */

import { expect } from 'chai';
import { describe, it, before, after, afterEach } from 'mocha';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { db } from '../../src/config/database';
import config from '../../src/config/env';
import app from '../../src/config/express';
import {
  bootstrapOrgWallets,
  creditOrgWallet,
  getOrgBalance,
} from '../../src/modules/infra/infraLedgerService';
import {
  createApiKey,
  rotateApiKey,
  type InfraAuth,
} from '../../src/modules/infra/infraService';
import {
  createCollection,
  createPayout,
  InfraRailError,
} from '../../src/modules/infra/infraMoneyService';
import { releasePayoutLock } from '../../src/modules/infra/infraLifecycleService';
import YellowCardService from '../../src/modules/payment/yellowCardService';
import {
  assertYellowCardWebhookAuthenticated,
  resolveYellowCardWebhookSecret,
  signYellowCardWebhook,
  YellowCardWebhookAuthError,
} from '../../src/modules/payment/yellowCardWebhook';

const ycProto = YellowCardService.prototype;
const ycOriginals = {
  isConfigured: ycProto.isConfigured,
  fetchChannels: ycProto.fetchChannels,
  createCollectionRequest: ycProto.createCollectionRequest,
  createPaymentRequest: ycProto.createPaymentRequest,
};

function restoreYellowCard(): void {
  ycProto.isConfigured = ycOriginals.isConfigured;
  ycProto.fetchChannels = ycOriginals.fetchChannels;
  ycProto.createCollectionRequest = ycOriginals.createCollectionRequest;
  ycProto.createPaymentRequest = ycOriginals.createPaymentRequest;
}

function stubYellowCard(partial: {
  configured?: boolean;
  channels?: Record<string, unknown>[];
  createCollectionRequest?: () => Promise<unknown>;
  createPaymentRequest?: () => Promise<unknown>;
}): void {
  if (partial.configured !== undefined) {
    ycProto.isConfigured = () => partial.configured as boolean;
  }
  if (partial.channels) {
    const list = partial.channels;
    ycProto.fetchChannels = async () => list;
  }
  if (partial.createCollectionRequest) {
    ycProto.createCollectionRequest = partial.createCollectionRequest;
  }
  if (partial.createPaymentRequest) {
    ycProto.createPaymentRequest = partial.createPaymentRequest;
  }
}

const NG_CHANNEL = [
  { id: 'ch-ng-bank', country: 'NG', currency: 'NGN', rampType: 'deposit' },
];

async function createTestOrg(suffix: string): Promise<{
  orgId: string;
  actor: InfraAuth;
}> {
  const slug = `p0-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`P0 Integrity ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  const member = await db.one<{ id: string; email: string }>(
    `INSERT INTO infra_members (org_id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', 'P0 Tester', 'admin')
     RETURNING id::text AS id, email`,
    [org.id, `p0-${suffix}-${crypto.randomBytes(4).toString('hex')}@dayfi.test`]
  );
  return {
    orgId: org.id,
    actor: {
      memberId: member.id,
      orgId: org.id,
      email: member.email,
      role: 'admin',
    },
  };
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
}

function signJwt(actor: InfraAuth): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return jwt.sign(
    { data: { ...actor, infra: true }, exp },
    String(config?.JWT_SECRET)
  );
}

async function httpJson(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

describe('infra P0 integrity', function () {
  this.timeout(60000);
  let orgId: string;
  let actor: InfraAuth;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const keys = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_api_keys') AS t`
    );
    if (!keys?.t) {
      throw new Error('Run migrations before test:infra-p0');
    }
    const created = await createTestOrg('main');
    orgId = created.orgId;
    actor = created.actor;
    await db.none(
      `UPDATE infra_members
       SET phone = '+2348012345678',
           date_of_birth = '1990-05-01',
           address = '12 Adeola Odeku, Lagos',
           bvn = '22123456789',
           name = COALESCE(NULLIF(name, ''), 'P0 Tester')
       WHERE org_id = $1`,
      [orgId]
    );

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
      server.on('error', reject);
    });
  });

  after(async () => {
    restoreYellowCard();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (orgId) await cleanupOrg(orgId);
  });

  afterEach(() => {
    restoreYellowCard();
  });

  describe('P0-1 API-key authentication', () => {
    it('authenticates GET /balance with Bearer sk_test_ and writes last_used_at', async () => {
      const created = await createApiKey(orgId, 'test', 'P0 proof key', actor);
      expect(created.secret).to.match(/^sk_test_/);

      const before = await db.one<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM infra_api_keys WHERE id = $1`,
        [created.id]
      );
      expect(before.last_used_at).to.equal(null);

      const res = await httpJson(baseUrl, '/api/infra/v1/balance', {
        headers: {
          Authorization: `Bearer ${created.secret}`,
          'X-Dayfi-Environment': 'live',
        },
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body?.status).to.equal('success');
      expect(res.body?.data?.environment).to.equal('test');
      expect(res.body?.data?.orgId).to.equal(orgId);
      expect(res.body?.data?.available).to.equal(0);

      const after = await db.one<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM infra_api_keys WHERE id = $1`,
        [created.id]
      );
      expect(after.last_used_at).to.not.equal(null);
    });

    it('rejects a forged key and still accepts JWT', async () => {
      const bad = await httpJson(baseUrl, '/api/infra/v1/balance', {
        headers: {
          Authorization: `Bearer sk_test_${crypto.randomBytes(24).toString('hex')}`,
        },
      });
      expect(bad.status).to.equal(401);

      const token = signJwt(actor);
      const ok = await httpJson(baseUrl, '/api/infra/v1/balance', {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Dayfi-Environment': 'test',
        },
      });
      expect(ok.status, JSON.stringify(ok.body)).to.equal(200);
      expect(ok.body?.data?.environment).to.equal('test');
    });

    it('rejects a rotated secret and LIVE keys on an unverified org', async () => {
      const created = await createApiKey(orgId, 'test', 'rotate-me', actor);
      const rotated = await rotateApiKey(orgId, 'test', created.id, actor);
      expect(rotated?.secret).to.match(/^sk_test_/);

      const oldKey = await httpJson(baseUrl, '/api/infra/v1/balance', {
        headers: { Authorization: `Bearer ${created.secret}` },
      });
      expect(oldKey.status).to.equal(401);

      const live = await createApiKey(orgId, 'live', 'live-unverified', actor);
      const liveRes = await httpJson(baseUrl, '/api/infra/v1/balance', {
        headers: { Authorization: `Bearer ${live.secret}` },
      });
      expect(liveRes.status).to.equal(403);
    });
  });

  describe('P0-2 LIVE Collect failure safety', () => {
    it('TEST collect still returns Dayfi instructions and does not credit', async () => {
      const before = await getOrgBalance(orgId, 'test');
      const created = await createCollection({
        orgId,
        env: 'test',
        amount: 1500,
        currency: 'NGN',
        country: 'NG',
      });
      expect(created.status).to.equal('pending');
      const instructions = created.instructions as {
        accountNumber?: string | null;
        bankName?: string | null;
      };
      expect(instructions.accountNumber).to.match(/^\d+$/);
      expect(instructions.bankName).to.equal('Flutterwave MFB');
      const after = await getOrgBalance(orgId, 'test');
      expect(after.available).to.equal(before.available);
    });

    it('LIVE without Flutterwave for NG NGN fails closed (no synthetic account)', async () => {
      stubYellowCard({ configured: false });
      const before = await getOrgBalance(orgId, 'live');
      let caught: InfraRailError | null = null;
      try {
        await createCollection({
          orgId,
          env: 'live',
          amount: 2000,
          currency: 'NGN',
          country: 'NG',
          customerEmail: 'buyer@example.com',
        });
        expect.fail('LIVE collect should fail closed');
      } catch (err) {
        expect(err).to.be.instanceOf(InfraRailError);
        caught = err as InfraRailError;
      }
      expect(caught?.status).to.equal(502);
      expect(caught?.transactionId).to.be.a('string');

      const row = await db.one<{
        status: string;
        metadata: Record<string, unknown>;
      }>(`SELECT status, metadata FROM infra_transactions WHERE id = $1`, [
        caught!.transactionId,
      ]);
      expect(row.status).to.equal('failed');
      expect(row.metadata?.instructions).to.equal(null);
      expect(JSON.stringify(row.metadata)).to.not.include('Dayfi Collections');
      expect(String(row.metadata?.providerError || '')).to.match(/Flutterwave|not configured/i);

      const after = await getOrgBalance(orgId, 'live');
      expect(after.available).to.equal(before.available);
    });

    it('LIVE Yellow Card submit failure does not invent pay-in details', async () => {
      stubYellowCard({
        configured: true,
        channels: NG_CHANNEL,
        createCollectionRequest: async () => {
          throw new Error('channel unavailable');
        },
      });
      const before = await getOrgBalance(orgId, 'live');
      let caught: InfraRailError | null = null;
      try {
        await createCollection({
          orgId,
          env: 'live',
          amount: 3000,
          currency: 'KES',
          country: 'KE',
          customerEmail: 'buyer@example.com',
        });
        expect.fail('LIVE collect should not succeed');
      } catch (err) {
        caught = err as InfraRailError;
      }
      expect(caught).to.be.instanceOf(InfraRailError);
      expect(caught?.message).to.match(/channel unavailable/i);

      const row = await db.one<{
        status: string;
        metadata: Record<string, unknown>;
      }>(`SELECT status, metadata FROM infra_transactions WHERE id = $1`, [
        caught!.transactionId,
      ]);
      expect(row.status).to.equal('failed');
      expect(row.metadata?.instructions).to.equal(null);
      const blob = JSON.stringify(row.metadata);
      expect(blob).to.not.match(/"accountNumber"\s*:\s*"9\d{9}"/);
      expect(blob).to.not.include('Dayfi Collections');

      const after = await getOrgBalance(orgId, 'live');
      expect(after.available).to.equal(before.available);
    });
  });

  describe('P0-3 LIVE Send failure safety', () => {
    it('LIVE YC submit failure releases the lock; second release is idempotent', async () => {
      await creditOrgWallet({
        orgId,
        environment: 'live',
        amount: 200,
        idempotencyKey: `p0-send-seed-${orgId}`,
      });
      const before = await getOrgBalance(orgId, 'live');
      expect(before.available).to.be.at.least(200);

      stubYellowCard({
        configured: true,
        channels: NG_CHANNEL,
        createPaymentRequest: async () => {
          throw new Error('YC payout rejected');
        },
      });

      let caught: InfraRailError | null = null;
      try {
        await createPayout({
          orgId,
          env: 'live',
          amount: 40,
          currency: 'USDC',
          country: 'NG',
          accountType: 'momo',
          accountNumber: '08012345678',
          accountName: 'P0 Payee',
          networkId: 'mtn',
        });
        expect.fail('LIVE payout should fail after YC reject');
      } catch (err) {
        caught = err as InfraRailError;
      }
      expect(caught).to.be.instanceOf(InfraRailError);
      expect(caught?.message).to.match(/YC payout rejected/i);
      expect(caught?.transactionId).to.be.a('string');

      const row = await db.one<{
        status: string;
        metadata: Record<string, unknown>;
      }>(`SELECT status, metadata FROM infra_transactions WHERE id = $1`, [
        caught!.transactionId,
      ]);
      expect(row.status).to.equal('failed');
      expect(row.metadata?.fundsReleased).to.equal(true);

      const afterFail = await getOrgBalance(orgId, 'live');
      expect(afterFail.available).to.equal(before.available);
      expect(afterFail.locked).to.equal(before.locked);

      const second = await releasePayoutLock({
        orgId,
        transactionId: caught!.transactionId!,
        source: 'yellowcard_submit_failed',
        status: 'failed',
      });
      expect(second.release.duplicate).to.equal(true);
      const afterSecond = await getOrgBalance(orgId, 'live');
      expect(afterSecond.available).to.equal(before.available);
    });

    it('LIVE without Yellow Card does not lock funds', async () => {
      stubYellowCard({ configured: false });
      const before = await getOrgBalance(orgId, 'live');
      try {
        await createPayout({
          orgId,
          env: 'live',
          amount: 10,
          currency: 'USDC',
          country: 'NG',
          accountType: 'momo',
          accountNumber: '08012345678',
          accountName: 'P0 Payee',
          networkId: 'mtn',
        });
        expect.fail('should fail closed');
      } catch (err) {
        expect(err).to.be.instanceOf(InfraRailError);
      }
      const after = await getOrgBalance(orgId, 'live');
      expect(after.available).to.equal(before.available);
      expect(after.locked).to.equal(before.locked);
    });
  });

  describe('P0-4 Yellow Card webhook signature', () => {
    function webhookSecret(): string {
      return resolveYellowCardWebhookSecret() || 'p0-integrity-yc-secret';
    }

    before(() => {
      if (!resolveYellowCardWebhookSecret()) {
        process.env.DAYFI_YELLOWCARD_API_SECRET = 'p0-integrity-yc-secret';
      }
    });

    it('rejects missing and invalid signatures before lifecycle', () => {
      expect(() =>
        assertYellowCardWebhookAuthenticated('{}', undefined, 'secret')
      ).to.throw(YellowCardWebhookAuthError, /Missing webhook signature/i);
      expect(() =>
        assertYellowCardWebhookAuthenticated('{}', 'not-a-valid-hmac', 'secret')
      ).to.throw(YellowCardWebhookAuthError, /Invalid webhook signature/i);
      expect(() =>
        assertYellowCardWebhookAuthenticated('{}', 'aaaa', '')
      ).to.throw(YellowCardWebhookAuthError, /not configured/i);
    });

    it('HTTP: unsigned and invalid signatures do not credit a pending collection', async () => {
      const sequenceId = `p0-wh-${crypto.randomUUID()}`;
      await db.none(
        `INSERT INTO infra_transactions
           (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
         VALUES ($1, 'test', 80, 'USDC', 'pending', 'bank_transfer', 'payment', 0, $2, $3::jsonb)`,
        [
          orgId,
          sequenceId,
          JSON.stringify({ type: 'collection', usdcAmount: 80 }),
        ]
      );
      const before = await getOrgBalance(orgId, 'test');
      const raw = JSON.stringify({
        sequenceId,
        event: 'COLLECTION.COMPLETE',
        status: 'complete',
        id: `evt-${sequenceId}`,
      });
      const secret = webhookSecret();

      const unsigned = await httpJson(
        baseUrl,
        '/api/infra/v1/webhooks/yellowcard',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: raw,
        }
      );
      expect(unsigned.status).to.equal(401);

      const invalid = await httpJson(
        baseUrl,
        '/api/infra/v1/webhooks/yellowcard',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Yc-Signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          },
          body: raw,
        }
      );
      expect(invalid.status).to.equal(401);

      const afterBlocked = await getOrgBalance(orgId, 'test');
      expect(afterBlocked.available).to.equal(before.available);

      const valid = await httpJson(baseUrl, '/api/infra/v1/webhooks/yellowcard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Yc-Signature': signYellowCardWebhook(raw, secret),
        },
        body: raw,
      });
      expect(valid.status, JSON.stringify(valid.body)).to.equal(200);
      expect(valid.body?.data?.handled).to.equal(true);
      expect(valid.body?.data?.action).to.equal('collection_credit');

      const afterValid = await getOrgBalance(orgId, 'test');
      expect(afterValid.available).to.equal(before.available + 80);
    });
  });
});
