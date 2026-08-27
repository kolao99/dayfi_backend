/**
 * Dayfi Back Office — organizations (read-only) + invite regression.
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import { db } from '../../src/config/database';
import HashText from '../../src/shared/services/hashing';
import config from '../../src/config/env';
import {
  operatorLogin,
  createInviteCode,
  listInviteCodes,
  revokeInviteCode,
  redeemInviteCode,
  assertInviteAssignable,
  decodeOperatorToken,
  INVITE_WRITE_ROLES,
  ORG_READ_ROLES,
  roleAtLeast,
  listOrganizations,
  getOrganization,
  listOrganizationMembers,
  listAdminTransactions,
  getAdminTransaction,
  listAdminWallets,
  getAdminWallet,
  listAdminCollections,
  getAdminCollection,
  listAdminPayouts,
  getAdminPayout,
  TX_READ_ROLES,
  WALLET_READ_ROLES,
  type OperatorAuth,
  type OperatorRole,
} from '../../src/modules/infra/infraAdminService';
import { getOrgBalance, creditOrgWallet } from '../../src/modules/infra/infraLedgerService';

describe('infra back office invites', function () {
  this.timeout(30000);

  let ops: OperatorAuth;
  let viewer: OperatorAuth;
  const createdInviteIds: string[] = [];

  before(async () => {
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_operators') AS t`
    );
    if (!reg?.t) {
      throw new Error(
        'infra_operators missing — run migrations before test:infra-admin'
      );
    }

    const opsEmail = `ops-test-${Date.now()}@dayfi.co`;
    const viewerEmail = `viewer-test-${Date.now()}@dayfi.co`;
    const hash = await HashText.getHash('test-ops-pass');
    const viewerHash = await HashText.getHash('test-viewer-pass');

    await db.none(
      `INSERT INTO infra_operators (email, password_hash, name, role)
       VALUES ($1, $2, 'Ops Tester', 'ops'), ($3, $4, 'Viewer Tester', 'viewer')`,
      [opsEmail, hash, viewerEmail, viewerHash]
    );

    const loginOps = await operatorLogin(opsEmail, 'test-ops-pass');
    ops = loginOps.operator;
    const loginViewer = await operatorLogin(viewerEmail, 'test-viewer-pass');
    viewer = loginViewer.operator;

    expect(decodeOperatorToken(loginOps.token)?.operatorId).to.equal(ops.operatorId);
  });

  after(async () => {
    for (const id of createdInviteIds) {
      await db.none(`DELETE FROM infra_invite_codes WHERE id = $1`, [id]);
    }
    await db.none(
      `DELETE FROM infra_operator_audit WHERE operator_id = ANY($1::uuid[])`,
      [[ops?.operatorId, viewer?.operatorId].filter(Boolean)]
    );
    if (ops?.operatorId) {
      await db.none(`DELETE FROM infra_operators WHERE id = $1`, [ops.operatorId]);
    }
    if (viewer?.operatorId) {
      await db.none(`DELETE FROM infra_operators WHERE id = $1`, [
        viewer.operatorId,
      ]);
    }
  });

  it('rejects merchant-style tokens missing infraOperator', async () => {
    expect(decodeOperatorToken('not-a-jwt')).to.equal(null);
  });

  it('role gate: viewer cannot write invites', () => {
    expect(roleAtLeast(viewer.role, INVITE_WRITE_ROLES)).to.equal(false);
    expect(roleAtLeast(ops.role, INVITE_WRITE_ROLES)).to.equal(true);
  });

  it('creates invite assigned to email', async () => {
    const item = await createInviteCode({
      assignedEmail: 'founder@acme.com',
      label: 'Acme pilot',
      maxUses: 1,
      expiresInDays: 14,
      environment: 'test',
      operator: ops,
    });
    createdInviteIds.push(item.id);
    expect(item.code).to.match(/^DF-/);
    expect(item.assignedEmail).to.equal('founder@acme.com');
    expect(item.status).to.equal('ACTIVE');
    expect(item.maxUses).to.equal(1);
  });

  it('lists invites including created code', async () => {
    const items = await listInviteCodes({ search: 'founder@acme.com' });
    expect(items.some((i) => i.assignedEmail === 'founder@acme.com')).to.equal(
      true
    );
  });

  it('blocks wrong email redemption', async () => {
    const items = await listInviteCodes({ search: 'Acme pilot' });
    const invite = items.find((i) => i.label === 'Acme pilot');
    expect(invite).to.exist;
    try {
      await assertInviteAssignable({
        code: invite!.code,
        email: 'random@gmail.com',
      });
      expect.fail('should reject wrong email');
    } catch (err: any) {
      expect(String(err.message)).to.match(/assigned to/i);
    }
  });

  it('redeems with assigned email and marks USED', async () => {
    const items = await listInviteCodes({ search: 'Acme pilot' });
    const invite = items.find((i) => i.label === 'Acme pilot' && i.status === 'ACTIVE');
    expect(invite).to.exist;
    await redeemInviteCode({
      code: invite!.code,
      email: 'founder@acme.com',
    });
    const after = await listInviteCodes({ search: invite!.code });
    const row = after.find((i) => i.id === invite!.id);
    expect(row?.status).to.equal('USED');
    expect(row?.redeemedByEmail).to.equal('founder@acme.com');
    expect(row?.usesCount).to.equal(1);
  });

  it('revokes an active invite', async () => {
    const item = await createInviteCode({
      assignedEmail: 'revoke@acme.com',
      maxUses: 5,
      operator: ops,
    });
    createdInviteIds.push(item.id);
    const revoked = await revokeInviteCode(item.id, ops);
    expect(revoked.status).to.equal('REVOKED');
    try {
      await assertInviteAssignable({
        code: item.code,
        email: 'revoke@acme.com',
      });
      expect.fail('revoked should fail');
    } catch (err: any) {
      expect(String(err.message)).to.match(/revoked/i);
    }
  });

  it('rejects expired invite', async () => {
    const item = await createInviteCode({
      assignedEmail: 'expired@acme.com',
      maxUses: 1,
      expiresInDays: null,
      operator: ops,
    });
    createdInviteIds.push(item.id);
    await db.none(
      `UPDATE infra_invite_codes SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [item.id]
    );
    try {
      await assertInviteAssignable({
        code: item.code,
        email: 'expired@acme.com',
      });
      expect.fail('expired should fail');
    } catch (err: any) {
      expect(String(err.message)).to.match(/expired/i);
    }
  });

  it('rejects max-use exhaustion', async () => {
    const item = await createInviteCode({
      assignedEmail: 'once@acme.com',
      maxUses: 1,
      operator: ops,
    });
    createdInviteIds.push(item.id);
    await redeemInviteCode({ code: item.code, email: 'once@acme.com' });
    try {
      await assertInviteAssignable({
        code: item.code,
        email: 'once@acme.com',
      });
      expect.fail('exhausted should fail');
    } catch (err: any) {
      expect(String(err.message)).to.match(/used/i);
    }
  });

  it('writes operator audit for create/revoke/redeem', async () => {
    const rows = await db.manyOrNone<{ action: string }>(
      `SELECT action FROM infra_operator_audit
       WHERE operator_email = $1 OR action = 'INVITE_REDEEMED'
       ORDER BY created_at DESC
       LIMIT 40`,
      [ops.email]
    );
    const actions = rows.map((r) => r.action);
    expect(actions).to.include('INVITE_CREATED');
    expect(actions).to.include('INVITE_REVOKED');
    expect(actions).to.include('INVITE_REDEEMED');
  });
});

describe('infra back office organizations', function () {
  this.timeout(30000);

  let orgId: string;
  let memberId: string;
  const slug = `bo-org-${Date.now()}`;
  const memberEmail = `member-${Date.now()}@acme.test`;

  before(async () => {
    const org = await db.one<{ id: string }>(
      `INSERT INTO infra_organizations (name, slug, verification_status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      ['Acme Back Office Co', slug]
    );
    orgId = org.id;
    const member = await db.one<{ id: string }>(
      `INSERT INTO infra_members
         (org_id, email, password_hash, name, role, first_name, last_name, account_type)
       VALUES ($1, $2, $3, 'Founder Acme', 'admin', 'Founder', 'Acme', 'business')
       RETURNING id`,
      [orgId, memberEmail, await HashText.getHash('unused-pass')]
    );
    memberId = member.id;
  });

  after(async () => {
    if (memberId) {
      await db.none(`DELETE FROM infra_members WHERE id = $1`, [memberId]);
    }
    if (orgId) {
      await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
    }
  });

  it('all operator roles may read organizations', () => {
    const roles: OperatorRole[] = [
      'viewer',
      'support',
      'ops',
      'treasury',
      'admin',
    ];
    for (const role of roles) {
      expect(roleAtLeast(role, ORG_READ_ROLES)).to.equal(true);
    }
  });

  it('rejects merchant JWT shape for operator decode', () => {
    const merchantToken = jwt.sign(
      {
        data: {
          memberId: '00000000-0000-4000-8000-000000000001',
          orgId,
          email: memberEmail,
          role: 'admin',
          infra: true,
        },
        exp: dayjs().add(1, 'hour').unix(),
      },
      String(config?.JWT_SECRET)
    );
    expect(decodeOperatorToken(merchantToken)).to.equal(null);
  });

  it('lists organizations including seeded org', async () => {
    const data = await listOrganizations({ search: 'Acme Back Office Co' });
    expect(data.total).to.be.at.least(1);
    const hit = data.items.find((i) => i.id === orgId);
    expect(hit).to.exist;
    expect(hit!.verificationStatus).to.equal('pending');
    expect(hit!.memberCount).to.equal(1);
    expect(hit!.contactEmail).to.equal(memberEmail);
    expect((hit as any).passwordHash).to.equal(undefined);
  });

  it('searches by member email', async () => {
    const data = await listOrganizations({ search: memberEmail });
    expect(data.items.some((i) => i.id === orgId)).to.equal(true);
  });

  it('searches by organization id', async () => {
    const data = await listOrganizations({ search: orgId });
    expect(data.items).to.have.length(1);
    expect(data.items[0].id).to.equal(orgId);
  });

  it('filters by verification status', async () => {
    const pending = await listOrganizations({
      verificationStatus: 'pending',
      search: slug,
    });
    expect(pending.items.some((i) => i.id === orgId)).to.equal(true);
    const verified = await listOrganizations({
      verificationStatus: 'verified',
      search: slug,
    });
    expect(verified.items.some((i) => i.id === orgId)).to.equal(false);
  });

  it('returns organization detail with real verification status', async () => {
    const item = await getOrganization(orgId);
    expect(item.id).to.equal(orgId);
    expect(item.name).to.equal('Acme Back Office Co');
    expect(item.slug).to.equal(slug);
    expect(item.verificationStatus).to.equal('pending');
    expect(item.memberCount).to.equal(1);
    expect(item.contactEmail).to.equal(memberEmail);
    expect(JSON.stringify(item)).to.not.match(/password|bvn|otp|secret|private/i);
  });

  it('lists organization members without secrets', async () => {
    const items = await listOrganizationMembers(orgId);
    expect(items).to.have.length(1);
    expect(items[0].email).to.equal(memberEmail);
    expect(items[0].role).to.equal('admin');
    expect(items[0].name).to.equal('Founder Acme');
    expect((items[0] as any).passwordHash).to.equal(undefined);
    expect((items[0] as any).password_hash).to.equal(undefined);
    expect((items[0] as any).bvn).to.equal(undefined);
    expect(JSON.stringify(items[0])).to.not.match(/password|otp|google_sub|bvn/i);
  });

  it('returns 404 for missing organization', async () => {
    try {
      await getOrganization('00000000-0000-4000-8000-000000000099');
      expect.fail('should 404');
    } catch (err: any) {
      expect(err.message).to.match(/not found/i);
      expect(err.status).to.equal(404);
    }
  });

  it('returns 404 for members of missing organization', async () => {
    try {
      await listOrganizationMembers('00000000-0000-4000-8000-000000000099');
      expect.fail('should 404');
    } catch (err: any) {
      expect(err.message).to.match(/not found/i);
      expect(err.status).to.equal(404);
    }
  });
});

describe('infra back office transactions', function () {
  this.timeout(30000);

  let orgA: string;
  let orgB: string;
  let txA: string;
  let txB: string;
  const stamp = Date.now();

  before(async () => {
    const a = await db.one<{ id: string }>(
      `INSERT INTO infra_organizations (name, slug, verification_status)
       VALUES ($1, $2, 'unverified') RETURNING id`,
      [`Tx Org A ${stamp}`, `tx-org-a-${stamp}`]
    );
    const b = await db.one<{ id: string }>(
      `INSERT INTO infra_organizations (name, slug, verification_status)
       VALUES ($1, $2, 'unverified') RETURNING id`,
      [`Tx Org B ${stamp}`, `tx-org-b-${stamp}`]
    );
    orgA = a.id;
    orgB = b.id;

    const rowA = await db.one<{ id: string }>(
      `INSERT INTO infra_transactions
         (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
       VALUES ($1, 'test', 100.5, 'USDC', 'settled', 'bank_transfer', 'payout', 0,
               $2, $3::jsonb)
       RETURNING id::text AS id`,
      [
        orgA,
        `ext-a-${stamp}`,
        JSON.stringify({
          savedRecipient: { recipientName: 'Alice Counterparty', rail: 'bank' },
          privateKey: 'SHOULD_NOT_LEAK',
          bvn: '12345678901',
        }),
      ]
    );
    const rowB = await db.one<{ id: string }>(
      `INSERT INTO infra_transactions
         (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
       VALUES ($1, 'live', 50, 'NGN', 'pending', 'card', 'payment', 0,
               $2, $3::jsonb)
       RETURNING id::text AS id`,
      [
        orgB,
        `ext-b-${stamp}`,
        JSON.stringify({ recipient: { accountName: 'Bob Payor' } }),
      ]
    );
    txA = rowA.id;
    txB = rowB.id;
  });

  after(async () => {
    if (txA) await db.none(`DELETE FROM infra_transactions WHERE id = $1`, [txA]);
    if (txB) await db.none(`DELETE FROM infra_transactions WHERE id = $1`, [txB]);
    if (orgA) await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgA]);
    if (orgB) await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgB]);
  });

  it('all operator roles may read transactions', () => {
    for (const role of [
      'viewer',
      'support',
      'ops',
      'treasury',
      'admin',
    ] as OperatorRole[]) {
      expect(roleAtLeast(role, TX_READ_ROLES)).to.equal(true);
    }
  });

  it('lists transactions across organizations', async () => {
    const data = await listAdminTransactions({ search: `Tx Org` });
    const ids = data.items.map((i) => i.id);
    expect(ids).to.include(txA);
    expect(ids).to.include(txB);
    const a = data.items.find((i) => i.id === txA)!;
    expect(a.organizationName).to.match(/Tx Org A/);
    expect(a.orgId).to.equal(orgA);
    expect(a.amount).to.equal('100.5000000');
    expect(a.counterparty).to.equal('Alice Counterparty');
    expect(a.rail).to.equal('bank');
  });

  it('filters by organization', async () => {
    const data = await listAdminTransactions({ orgId: orgA });
    expect(data.items.every((i) => i.orgId === orgA)).to.equal(true);
    expect(data.items.some((i) => i.id === txA)).to.equal(true);
    expect(data.items.some((i) => i.id === txB)).to.equal(false);
  });

  it('filters by status, type, and environment', async () => {
    const byStatus = await listAdminTransactions({
      status: 'pending',
      orgId: orgB,
    });
    expect(byStatus.items.some((i) => i.id === txB)).to.equal(true);

    const byType = await listAdminTransactions({ type: 'payout', orgId: orgA });
    expect(byType.items.some((i) => i.id === txA)).to.equal(true);
    expect(byType.items.every((i) => i.type === 'payout')).to.equal(true);

    const byEnv = await listAdminTransactions({
      environment: 'live',
      orgId: orgB,
    });
    expect(byEnv.items.some((i) => i.id === txB)).to.equal(true);
    expect(byEnv.items.every((i) => i.environment === 'live')).to.equal(true);
  });

  it('searches by external reference', async () => {
    const data = await listAdminTransactions({ search: `ext-a-${stamp}` });
    expect(data.items.some((i) => i.id === txA)).to.equal(true);
  });

  it('paginates results', async () => {
    const page1 = await listAdminTransactions({
      orgId: orgA,
      limit: 1,
      offset: 0,
    });
    expect(page1.limit).to.equal(1);
    expect(page1.items).to.have.length(1);
    expect(page1.total).to.be.at.least(1);
    expect(typeof page1.hasNext).to.equal('boolean');
    expect(page1.page).to.equal(1);
  });

  it('returns empty results for unmatched filters', async () => {
    const data = await listAdminTransactions({
      orgId: orgA,
      status: 'this-status-does-not-exist',
    });
    expect(data.items).to.have.length(0);
    expect(data.total).to.equal(0);
  });

  it('returns transaction detail without secrets', async () => {
    const item = await getAdminTransaction(txA);
    expect(item.id).to.equal(txA);
    expect(item.organizationName).to.match(/Tx Org A/);
    expect(item.amount).to.equal('100.5000000');
    expect(JSON.stringify(item)).to.not.match(/SHOULD_NOT_LEAK|12345678901|privateKey|"bvn"/i);
    expect((item as any).metadata?.privateKey).to.equal(undefined);
    expect((item as any).metadata?.bvn).to.equal(undefined);
  });

  it('returns 404 for missing transaction', async () => {
    try {
      await getAdminTransaction('00000000-0000-4000-8000-000000000099');
      expect.fail('should 404');
    } catch (err: any) {
      expect(err.message).to.match(/not found/i);
      expect(err.status).to.equal(404);
    }
  });
});

describe('infra back office wallets', function () {
  this.timeout(30000);

  let orgId: string;
  let walletId: string;
  let movementId: string | null = null;
  const stamp = Date.now();

  before(async () => {
    const org = await db.one<{ id: string }>(
      `INSERT INTO infra_organizations (name, slug, verification_status)
       VALUES ($1, $2, 'unverified') RETURNING id`,
      [`Wallet Org ${stamp}`, `wallet-org-${stamp}`]
    );
    orgId = org.id;

    const wallet = await db.one<{ id: string }>(
      `INSERT INTO infra_wallet_accounts
         (org_id, environment, asset, status, available, pending, locked)
       VALUES ($1, 'test', 'USDC', 'active', 100, 5, 10)
       RETURNING id::text AS id`,
      [orgId]
    );
    walletId = wallet.id;

    // Also create a live wallet for env filter tests
    await db.none(
      `INSERT INTO infra_wallet_accounts
         (org_id, environment, asset, status, available, pending, locked)
       VALUES ($1, 'live', 'USDC', 'active', 1, 0, 0)`,
      [orgId]
    );

    const mov = await creditOrgWallet({
      orgId,
      environment: 'test',
      amount: 2,
      asset: 'USDC',
      idempotencyKey: `bo-wallet-test-${stamp}`,
      movementType: 'adjustment',
      reference: `bo-ref-${stamp}`,
      metadata: { privateKey: 'LEAK', note: 'ok' },
    });
    movementId = mov.id;
  });

  after(async () => {
    if (orgId) {
      await db.none(`DELETE FROM infra_ledger_movements WHERE org_id = $1`, [
        orgId,
      ]);
      await db.none(`DELETE FROM infra_wallet_accounts WHERE org_id = $1`, [
        orgId,
      ]);
      await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
    }
  });

  it('all operator roles may read wallets', () => {
    for (const role of [
      'viewer',
      'support',
      'ops',
      'treasury',
      'admin',
    ] as OperatorRole[]) {
      expect(roleAtLeast(role, WALLET_READ_ROLES)).to.equal(true);
    }
  });

  it('lists wallets across organizations', async () => {
    const data = await listAdminWallets({ search: `Wallet Org ${stamp}` });
    expect(data.total).to.be.at.least(2);
    expect(data.items.some((i) => i.id === walletId)).to.equal(true);
    expect(data.items.every((i) => i.organizationName)).to.equal(true);
  });

  it('filters by organization, environment, and currency', async () => {
    const byOrg = await listAdminWallets({ orgId });
    expect(byOrg.items.every((i) => i.orgId === orgId)).to.equal(true);

    const byEnv = await listAdminWallets({ orgId, environment: 'live' });
    expect(byEnv.items.length).to.be.at.least(1);
    expect(byEnv.items.every((i) => i.environment === 'live')).to.equal(true);

    const byCur = await listAdminWallets({ orgId, currency: 'USDC' });
    expect(byCur.items.every((i) => i.currency === 'USDC')).to.equal(true);
  });

  it('searches by organization name', async () => {
    const data = await listAdminWallets({ search: `Wallet Org ${stamp}` });
    expect(data.items.some((i) => i.orgId === orgId)).to.equal(true);
  });

  it('paginates wallets', async () => {
    const page1 = await listAdminWallets({ orgId, limit: 1, offset: 0 });
    expect(page1.items).to.have.length(1);
    expect(page1.limit).to.equal(1);
    expect(typeof page1.hasNext).to.equal('boolean');
  });

  it('wallet balances match getOrgBalance projection', async () => {
    const merchant = await getOrgBalance(orgId, 'test', 'USDC');
    const listed = await listAdminWallets({ orgId, environment: 'test' });
    const row = listed.items.find((i) => i.id === walletId);
    expect(row).to.exist;
    expect(Number(row!.available)).to.equal(merchant.available);
    expect(Number(row!.pending)).to.equal(merchant.pending);
    expect(Number(row!.locked)).to.equal(merchant.locked);

    const detail = await getAdminWallet(walletId);
    expect(Number(detail.item.available)).to.equal(merchant.available);
    expect(Number(detail.item.pending)).to.equal(merchant.pending);
    expect(Number(detail.item.locked)).to.equal(merchant.locked);
    expect(detail.item.projectionSource).to.equal('getOrgBalance');
  });

  it('wallet detail ledger movements belong to the wallet', async () => {
    const detail = await getAdminWallet(walletId);
    expect(detail.movements.length).to.be.at.least(1);
    expect(
      detail.movements.every((m) => m.walletAccountId === walletId)
    ).to.equal(true);
    if (movementId) {
      expect(detail.movements.some((m) => m.id === movementId)).to.equal(true);
    }
    expect(JSON.stringify(detail)).to.not.match(/LEAK|privateKey/i);
  });

  it('returns 404 for missing wallet', async () => {
    try {
      await getAdminWallet('00000000-0000-4000-8000-000000000099');
      expect.fail('should 404');
    } catch (err: any) {
      expect(err.message).to.match(/not found/i);
      expect(err.status).to.equal(404);
    }
  });

  it('does not expose private wallet material', async () => {
    const detail = await getAdminWallet(walletId);
    expect(JSON.stringify(detail)).to.not.match(
      /privateKey|seed|mnemonic|secretKey|password/i
    );
  });
});

describe('infra back office collections & payouts', function () {
  this.timeout(30000);

  let orgId: string;
  let collectionId: string;
  let payoutId: string;
  const stamp = Date.now();

  before(async () => {
    const org = await db.one<{ id: string }>(
      `INSERT INTO infra_organizations (name, slug, verification_status)
       VALUES ($1, $2, 'unverified') RETURNING id`,
      [`Flow Org ${stamp}`, `flow-org-${stamp}`]
    );
    orgId = org.id;

    const col = await db.one<{ id: string }>(
      `INSERT INTO infra_transactions
         (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
       VALUES ($1, 'test', 250, 'USDC', 'settled', 'bank_transfer', 'payment', 0,
               $2, $3::jsonb)
       RETURNING id::text AS id`,
      [
        orgId,
        `col-${stamp}`,
        JSON.stringify({
          originatorName: 'Payor Corp',
          privateKey: 'NOPE',
          bvn: '999',
        }),
      ]
    );
    collectionId = col.id;

    const pay = await db.one<{ id: string }>(
      `INSERT INTO infra_transactions
         (org_id, environment, amount, currency, status, method, direction, fee, external_id, metadata)
       VALUES ($1, 'live', 80, 'NGN', 'processing', 'bank_transfer', 'payout', 1,
               $2, $3::jsonb)
       RETURNING id::text AS id`,
      [
        orgId,
        `pay-${stamp}`,
        JSON.stringify({
          savedRecipient: {
            recipientName: 'Acme Ltd',
            displayHint: 'GTBank ••••1234',
            rail: 'bank',
          },
          provider: 'Yellow Card',
          accountNumber: '0123456789',
        }),
      ]
    );
    payoutId = pay.id;
  });

  after(async () => {
    if (collectionId) {
      await db.none(`DELETE FROM infra_transactions WHERE id = $1`, [collectionId]);
    }
    if (payoutId) {
      await db.none(`DELETE FROM infra_transactions WHERE id = $1`, [payoutId]);
    }
    if (orgId) {
      await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
    }
  });

  it('lists collections as payment direction only', async () => {
    const data = await listAdminCollections({ orgId });
    expect(data.items.every((i) => i.direction === 'payment')).to.equal(true);
    expect(data.items.some((i) => i.id === collectionId)).to.equal(true);
    expect(data.items.some((i) => i.id === payoutId)).to.equal(false);
  });

  it('filters collections by status and environment', async () => {
    const data = await listAdminCollections({
      orgId,
      status: 'settled',
      environment: 'test',
    });
    expect(data.items.some((i) => i.id === collectionId)).to.equal(true);
  });

  it('searches and paginates collections', async () => {
    const found = await listAdminCollections({ search: `col-${stamp}` });
    expect(found.items.some((i) => i.id === collectionId)).to.equal(true);
    const page = await listAdminCollections({ orgId, limit: 1, offset: 0 });
    expect(page.items).to.have.length(1);
    expect(typeof page.hasNext).to.equal('boolean');
  });

  it('collection detail scrubs secrets and links transaction id', async () => {
    const item = await getAdminCollection(collectionId);
    expect(item.transactionId).to.equal(collectionId);
    expect(item.counterparty).to.equal('Payor Corp');
    expect(JSON.stringify(item)).to.not.match(/NOPE|"bvn"|privateKey/i);
  });

  it('rejects payout id as collection', async () => {
    try {
      await getAdminCollection(payoutId);
      expect.fail('should 404');
    } catch (err: any) {
      expect(err.status).to.equal(404);
    }
  });

  it('lists payouts as payout direction only', async () => {
    const data = await listAdminPayouts({ orgId });
    expect(data.items.every((i) => i.direction === 'payout')).to.equal(true);
    expect(data.items.some((i) => i.id === payoutId)).to.equal(true);
    expect(data.items.some((i) => i.id === collectionId)).to.equal(false);
  });

  it('filters payouts by organization/status/environment', async () => {
    const data = await listAdminPayouts({
      orgId,
      status: 'processing',
      environment: 'live',
    });
    expect(data.items.some((i) => i.id === payoutId)).to.equal(true);
  });

  it('searches and paginates payouts', async () => {
    const found = await listAdminPayouts({ search: `pay-${stamp}` });
    expect(found.items.some((i) => i.id === payoutId)).to.equal(true);
    const page = await listAdminPayouts({ orgId, limit: 1, offset: 0 });
    expect(page.items).to.have.length(1);
  });

  it('payout detail shows masked destination and provider', async () => {
    const item = await getAdminPayout(payoutId);
    expect(item.recipient).to.equal('Acme Ltd');
    expect(item.destination).to.equal('GTBank ••••1234');
    expect(item.provider).to.equal('Yellow Card');
    expect(item.rail).to.equal('bank');
    expect(JSON.stringify(item)).to.not.match(/0123456789/);
  });

  it('rejects collection id as payout', async () => {
    try {
      await getAdminPayout(collectionId);
      expect.fail('should 404');
    } catch (err: any) {
      expect(err.status).to.equal(404);
    }
  });
});
