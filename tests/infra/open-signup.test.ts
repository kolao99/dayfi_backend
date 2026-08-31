/**
 * Open signup — invite codes are optional, not required for account creation.
 *
 * Run: npm run test:infra-open-signup
 */

import { expect } from 'chai';
import { describe, it, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  signupWithPassword,
  checkEmail,
} from '../../src/modules/infra/infraService';

describe('infra open signup (no invite required)', function () {
  this.timeout(30000);

  const stamp = crypto.randomBytes(4).toString('hex');
  const email = `open-signup-${stamp}@dayfi.test`;
  let memberId: string | null = null;

  after(async () => {
    if (memberId) {
      await db.none(`DELETE FROM infra_members WHERE id = $1`, [memberId]);
    }
  });

  it('allows email check for new address without invite', async () => {
    const check = await checkEmail(email);
    expect(check.exists).to.equal(false);
    expect(check.action).to.equal('signup');
  });

  it('creates account via signup without invite code', async () => {
    const res = await signupWithPassword({
      email,
      password: 'TestPass123!',
      firstName: 'Open',
      lastName: 'Signup',
      accountType: 'business',
    });
    expect(res.action).to.equal('signup');
    const row = await db.oneOrNone<{ id: string }>(
      `SELECT id FROM infra_members WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    expect(row?.id).to.be.a('string');
    memberId = row!.id;
  });
});
