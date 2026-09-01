/**
 * Four Phase 1 — regression proof for the EXISTING consumer auth paths.
 *
 * The phone-identity migration relaxes `users.email` and `users.password` from
 * NOT NULL. That is the one change in Phase 1 that could silently break live
 * email/password, Google and Apple sign-in, so it is tested directly.
 *
 * Also proves rule D1: signing in by phone attaches a login method to an
 * EXISTING identity and mutates nothing else. It never forks a second account
 * and never merges two.
 *
 * Run: npm run test:four-regression
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';

import { expect } from 'chai';
import { describe, it, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import AuthService from '../../src/modules/authentication/services';
import { resetOtpProviderCache } from '../../src/modules/four/auth/otpProvider';
import {
  requestOtp,
  verifyOtp,
} from '../../src/modules/four/auth/phoneAuthService';
import { findUserByPhone } from '../../src/modules/four/auth/identityService';
import { isFourError } from '../../src/modules/four/errors';

const STUB_CODE = '123456';
const authService = new AuthService();

const emails: string[] = [];
const phones: string[] = [];

function stamp(): string {
  return crypto.randomBytes(5).toString('hex');
}

function trackEmail(email: string): string {
  emails.push(email);
  return email;
}

function randomNgPhone(): string {
  const phone = `+23480${crypto.randomInt(10_000_000, 99_999_999)}`;
  phones.push(phone);
  return phone;
}

/** An account exactly as the live consumer app would have created it. */
async function seedLegacyUser(options: {
  email: string;
  legacyPhone: string | null;
  level?: string;
  refreshToken?: string | null;
}): Promise<string> {
  const row = await db.one<{ user_id: string }>(
    `INSERT INTO users
       (email, password, first_name, last_name, phone_number, level, status, refresh_token)
     VALUES ($1, $2, 'Existing', 'User', $3, $4, 'active', $5)
     RETURNING user_id`,
    [
      options.email.toLowerCase(),
      '$2b$12$abcdefghijklmnopqrstuvREPLACEDHASHVALUEFORTESTINGxyz',
      options.legacyPhone,
      options.level ?? 'level-2',
      options.refreshToken ?? null,
    ]
  );
  return row.user_id;
}

describe('four: existing consumer auth is not broken by the phone migration', function () {
  this.timeout(30000);

  after(async () => {
    if (emails.length > 0) {
      await db.none(`DELETE FROM users WHERE email = ANY($1::text[])`, [
        emails.map((e) => e.toLowerCase()),
      ]);
    }
    if (phones.length > 0) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        phones,
      ]);
      await db.none(
        `DELETE FROM four_otp_challenges WHERE phone_e164 = ANY($1::text[])`,
        [phones]
      );
    }
  });

  describe('email/password signup and lookup still work', () => {
    it('creates a user through the existing createUser query', async () => {
      const email = trackEmail(`four-regression-${stamp()}@dayfi.test`);
      const created = await authService.createUser({
        email,
        password: '$2b$12$regressionhashvalueplaceholderforthistest',
        firstName: 'Legacy',
        lastName: 'Signup',
        middleName: '',
      });
      expect(created?.email).to.equal(email.toLowerCase());
      expect(created?.user_id).to.be.a('string');
    });

    it('finds that user through the existing getUserWithProfile query', async () => {
      const email = trackEmail(`four-regression-${stamp()}@dayfi.test`);
      await authService.createUser({
        email,
        password: '$2b$12$regressionhashvalueplaceholderforthistest',
        firstName: 'Lookup',
        lastName: 'Works',
        middleName: '',
      });

      const found = await authService.getAUser(email);
      expect(found?.email).to.equal(email.toLowerCase());
      expect(found?.first_name).to.equal('Lookup');
    });

    it('still enforces email uniqueness', async () => {
      const email = trackEmail(`four-regression-${stamp()}@dayfi.test`);
      await seedLegacyUser({ email, legacyPhone: null });

      let threw = false;
      try {
        await seedLegacyUser({ email, legacyPhone: null });
      } catch (err: any) {
        threw = true;
        expect(String(err?.code)).to.equal('23505');
      }
      expect(threw, 'duplicate email must still be rejected').to.equal(true);
    });

    it('allows many phone-only users to coexist with a NULL email', async () => {
      const a = randomNgPhone();
      const b = randomNgPhone();

      await requestOtp({ phone: a });
      await verifyOtp({ phone: a, code: STUB_CODE });
      await requestOtp({ phone: b });
      await verifyOtp({ phone: b, code: STUB_CODE });

      const rows = await db.manyOrNone<{ email: string | null }>(
        `SELECT email FROM users WHERE phone_e164 = ANY($1::text[])`,
        [[a, b]]
      );
      expect(rows).to.have.length(2);
      rows.forEach((r) => expect(r.email).to.equal(null));
    });
  });

  describe('D1: phone sign-in attaches to the existing identity', () => {
    it('signs into the existing account rather than creating a second one', async () => {
      const email = trackEmail(`four-existing-${stamp()}@dayfi.test`);
      const phone = randomNgPhone();
      const legacyPhone = `0${phone.slice(4)}`; // stored unnormalized
      const existingId = await seedLegacyUser({ email, legacyPhone });

      resetOtpProviderCache();
      await requestOtp({ phone });
      const result = await verifyOtp({ phone, code: STUB_CODE });

      expect(result.isNewUser).to.equal(false);
      expect(result.user.id).to.equal(existingId);

      const count = await db.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM users
          WHERE phone_e164 = $1 OR phone_number = $2`,
        [phone, legacyPhone]
      );
      expect(count.n, 'must not fork a second account').to.equal('1');
    });

    it('does not overwrite email, password or the social link', async () => {
      const email = trackEmail(`four-preserve-${stamp()}@dayfi.test`);
      const phone = randomNgPhone();
      const legacyPhone = `0${phone.slice(4)}`;
      const refreshToken = `google:${stamp()}`;
      const userId = await seedLegacyUser({
        email,
        legacyPhone,
        refreshToken,
      });

      const before = await db.one<{
        email: string;
        password: string;
        refresh_token: string;
      }>(
        `SELECT email, password, refresh_token FROM users WHERE user_id = $1`,
        [userId]
      );

      await requestOtp({ phone });
      await verifyOtp({ phone, code: STUB_CODE });

      const after = await db.one<{
        email: string;
        password: string;
        refresh_token: string;
        phone_e164: string;
        phone_verified: boolean;
      }>(
        `SELECT email, password, refresh_token, phone_e164, phone_verified
           FROM users WHERE user_id = $1`,
        [userId]
      );

      expect(after.email).to.equal(before.email);
      expect(after.password).to.equal(before.password);
      expect(after.refresh_token).to.equal(before.refresh_token);
      // Only phone verification state is added.
      expect(after.phone_e164).to.equal(phone);
      expect(after.phone_verified).to.equal(true);
    });

    it('never lowers an existing KYC level', async () => {
      const email = trackEmail(`four-level-${stamp()}@dayfi.test`);
      const phone = randomNgPhone();
      const userId = await seedLegacyUser({
        email,
        legacyPhone: `0${phone.slice(4)}`,
        level: 'level-3',
      });

      await requestOtp({ phone });
      await verifyOtp({ phone, code: STUB_CODE });

      const row = await db.one<{ level: string }>(
        `SELECT level FROM users WHERE user_id = $1`,
        [userId]
      );
      expect(row.level).to.equal('level-3');
    });

    it('raises a level-0 account to level-1 on phone verification', async () => {
      const email = trackEmail(`four-level0-${stamp()}@dayfi.test`);
      const phone = randomNgPhone();
      const userId = await seedLegacyUser({
        email,
        legacyPhone: `0${phone.slice(4)}`,
        level: 'level-0',
      });

      await requestOtp({ phone });
      await verifyOtp({ phone, code: STUB_CODE });

      const row = await db.one<{ level: string }>(
        `SELECT level FROM users WHERE user_id = $1`,
        [userId]
      );
      expect(row.level).to.equal('level-1');
    });
  });

  describe('D1.5: Four never merges two identities automatically', () => {
    it('refuses to resolve when two accounts claim the same number', async () => {
      const phone = randomNgPhone();
      const nsn = phone.slice(4);

      // Two legacy rows, different spellings, both normalizing to one number.
      await seedLegacyUser({
        email: trackEmail(`four-dup-a-${stamp()}@dayfi.test`),
        legacyPhone: `0${nsn}`,
      });
      await seedLegacyUser({
        email: trackEmail(`four-dup-b-${stamp()}@dayfi.test`),
        legacyPhone: `+234${nsn}`,
      });

      let code: string | null = null;
      try {
        await findUserByPhone(phone);
      } catch (err) {
        if (!isFourError(err)) throw err;
        code = err.code;
      }
      expect(code).to.equal('account_ambiguous');
    });

    it('refuses to sign in through the ambiguous number', async () => {
      const phone = randomNgPhone();
      const nsn = phone.slice(4);

      await seedLegacyUser({
        email: trackEmail(`four-dup-c-${stamp()}@dayfi.test`),
        legacyPhone: `0${nsn}`,
      });
      await seedLegacyUser({
        email: trackEmail(`four-dup-d-${stamp()}@dayfi.test`),
        legacyPhone: `234${nsn}`,
      });

      await requestOtp({ phone });

      let code: string | null = null;
      try {
        await verifyOtp({ phone, code: STUB_CODE });
      } catch (err) {
        if (!isFourError(err)) throw err;
        code = err.code;
      }
      expect(code).to.equal('account_ambiguous');
    });
  });
});
