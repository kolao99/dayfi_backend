/**
 * Increment B — per-org Stellar account (TESTNET-FIRST domain).
 *
 * Default: DAYFI_INFRA_STELLAR_PROVISION_MODE=mock (no network).
 * Optional live: MODE=live + STELLAR_NETWORK=testnet (Friendbot + USDC trustline).
 *
 * Run: npm run test:infra-stellar-accounts
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { bootstrapOrgWallets } from '../../src/modules/infra/infraLedgerService';
import {
  getInfraStellarProvisionMode,
  getOrgStellarAccount,
  getOrgStellarSigningSecret,
  provisionOrgStellarAccount,
} from '../../src/modules/infra/infraStellarAccountService';
import { resolveUsdcIssuer } from '../../src/config/stellarIssuers';

async function createTestOrg(suffix: string): Promise<string> {
  const slug = `stellar-acct-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await db.one<{ id: string }>(
    `INSERT INTO infra_organizations (name, slug, verification_status)
     VALUES ($1, $2, 'unverified')
     RETURNING id`,
    [`Stellar Account Test ${suffix}`, slug]
  );
  await bootstrapOrgWallets(org.id);
  return org.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  const rows = await db.manyOrNone<{ custody_ref: string }>(
    `SELECT custody_ref::text AS custody_ref FROM infra_stellar_accounts WHERE org_id = $1`,
    [orgId]
  );
  await db.none(`DELETE FROM infra_organizations WHERE id = $1`, [orgId]);
  for (const r of rows) {
    await db.none(`DELETE FROM infra_stellar_custody WHERE id = $1`, [r.custody_ref]);
  }
}

describe('infra stellar accounts (Increment B)', function () {
  this.timeout(60000);
  let orgId: string;

  before(async () => {
    process.env.DAYFI_INFRA_STELLAR_PROVISION_MODE = 'mock';
    process.env.STELLAR_NETWORK = 'testnet';
    const reg = await db.oneOrNone<{ t: string | null }>(
      `SELECT to_regclass('public.infra_stellar_accounts') AS t`
    );
    if (!reg?.t) {
      throw new Error(
        'Run migrations before test:infra-stellar-accounts (infra_stellar_accounts missing)'
      );
    }
    expect(getInfraStellarProvisionMode()).to.equal('mock');
    orgId = await createTestOrg('main');
  });

  after(async () => {
    if (orgId) await cleanupOrg(orgId);
  });

  it('returns null before provisioning', async () => {
    const before = await getOrgStellarAccount(orgId, 'test');
    expect(before).to.equal(null);
  });

  it('provisions Alice wallet: public key, ACTIVE, USDC issuer, no secret in view', async () => {
    const account = await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });

    expect(account.status).to.equal('active');
    expect(account.network).to.equal('testnet');
    expect(account.asset).to.equal('USDC');
    expect(account.publicKey).to.match(/^G[A-Z0-9]{55}$/);
    expect(account.usdcIssuer).to.equal(resolveUsdcIssuer(true));
    expect(account.xlmFundedAt).to.be.ok;
    expect(account.trustlineAt).to.be.ok;
    expect(account.activatedAt).to.be.ok;
    expect(account.custody.refPresent).to.equal(true);

    const serialized = JSON.stringify(account);
    expect(serialized).to.not.match(/S[A-Z0-9]{55}/);
    expect(serialized.toLowerCase()).to.not.include('secret');
  });

  it('is idempotent — second provision returns same public key', async () => {
    const first = await getOrgStellarAccount(orgId, 'test');
    const second = await provisionOrgStellarAccount({
      orgId,
      environment: 'test',
      mode: 'mock',
    });
    expect(second.publicKey).to.equal(first!.publicKey);
    expect(second.id).to.equal(first!.id);
    expect(second.status).to.equal('active');
  });

  it('stores encrypted custody separately from org / account public row', async () => {
    const account = await getOrgStellarAccount(orgId, 'test');
    const row = await db.one<{ custody_ref: string; public_key: string }>(
      `SELECT custody_ref::text AS custody_ref, public_key
       FROM infra_stellar_accounts WHERE id = $1`,
      [account!.id]
    );
    const custody = await db.one<{ secret_encrypted: string }>(
      `SELECT secret_encrypted FROM infra_stellar_custody WHERE id = $1`,
      [row.custody_ref]
    );
    expect(custody.secret_encrypted).to.include(':');
    expect(custody.secret_encrypted).to.not.match(/^S[A-Z0-9]{55}$/);

    const cols = await db.manyOrNone<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'infra_stellar_accounts'`
    );
    const names = cols.map((c) => c.column_name);
    expect(names).to.not.include('secret');
    expect(names).to.not.include('secret_encrypted');
    expect(names).to.not.include('private_key');
  });

  it('signing secret is available internally and matches public key', async () => {
    const { publicKey, secret } = await getOrgStellarSigningSecret(orgId, 'test');
    expect(publicKey).to.match(/^G[A-Z0-9]{55}$/);
    expect(secret).to.match(/^S[A-Z0-9]{55}$/);
    const StellarSdk = require('@stellar/stellar-sdk');
    expect(StellarSdk.Keypair.fromSecret(secret).publicKey()).to.equal(publicKey);
  });

  it('does not invent a Stellar payment hash during provision', async () => {
    const account = await getOrgStellarAccount(orgId, 'test');
    const meta = await db.one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM infra_stellar_accounts WHERE id = $1`,
      [account!.id]
    );
    expect(meta.metadata).to.not.have.property('transactionHash');
    expect(meta.metadata).to.not.have.property('stellarTxHash');
  });
});
