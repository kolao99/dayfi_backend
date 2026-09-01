/**
 * Four Phase 1 (C11, C4, C5) — phone + OTP authentication.
 *
 * Uses the stub OTP provider so the suite never sends real SMS or spends money.
 * Twilio itself is exercised separately against a real device.
 *
 * Run: npm run test:four-auth
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { resetOtpProviderCache } from '../../src/modules/four/auth/otpProvider';
import {
  requestOtp,
  verifyOtp,
} from '../../src/modules/four/auth/phoneAuthService';
import {
  createSession,
  validateSessionToken,
  revokeSessionByToken,
  revokeAllSessionsForUser,
  listActiveSessions,
} from '../../src/modules/four/auth/sessionService';
import { findUserByPhone } from '../../src/modules/four/auth/identityService';
import { isFourError } from '../../src/modules/four/errors';

const STUB_CODE = '123456';
const createdPhones: string[] = [];

/** A random, valid NG mobile number so runs never collide. */
function randomNgPhone(): string {
  const nsn = `80${crypto.randomInt(10_000_000, 99_999_999)}`;
  const phone = `+234${nsn}`;
  createdPhones.push(phone);
  return phone;
}

/**
 * Age existing challenges so the resend gap doesn't block unrelated cases.
 *
 * The default rewind also carries sends out of the sliding window, which is
 * what most tests want. Pass a shorter interval to clear the resend gap while
 * keeping sends INSIDE the window (used to exercise the window cap itself).
 */
async function allowImmediateResend(
  phone: string,
  interval = '10 minutes'
): Promise<void> {
  await db.none(
    `UPDATE four_otp_challenges
        SET created_at = created_at - $2::interval
      WHERE phone_e164 = $1`,
    [phone, interval]
  );
}

async function expectFourError(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await promise;
    expect.fail(`expected FourError(${code}) but the call resolved`);
  } catch (err) {
    if (!isFourError(err)) throw err;
    expect(err.code).to.equal(code);
  }
}

describe('four: phone + OTP authentication', function () {
  this.timeout(30000);

  before(() => {
    resetOtpProviderCache();
  });

  after(async () => {
    if (createdPhones.length > 0) {
      // four_sessions cascades on users.
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        createdPhones,
      ]);
      await db.none(
        `DELETE FROM four_otp_challenges WHERE phone_e164 = ANY($1::text[])`,
        [createdPhones]
      );
    }
  });

  describe('request-otp', () => {
    it('sends a code for a valid number', async () => {
      const phone = randomNgPhone();
      const result = await requestOtp({ phone });
      expect(result.sent).to.equal(true);
      expect(result.expiresInSeconds).to.be.greaterThan(0);
    });

    it('accepts an unnormalized number and stores the canonical form', async () => {
      const phone = randomNgPhone();
      const local = `0${phone.slice(4)}`; // +2348... -> 08...
      await requestOtp({ phone: local });

      const row = await db.oneOrNone<{ phone_e164: string }>(
        `SELECT phone_e164 FROM four_otp_challenges WHERE phone_e164 = $1 LIMIT 1`,
        [phone]
      );
      expect(row?.phone_e164).to.equal(phone);
    });

    it('rejects an invalid number', async () => {
      await expectFourError(requestOtp({ phone: '12345' }), 'invalid_phone');
    });

    it('does not create or reveal a user (no enumeration)', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });

      const user = await findUserByPhone(phone);
      expect(user, 'request-otp must not create a user').to.equal(null);
    });

    it('rate limits an immediate resend', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });
      await expectFourError(requestOtp({ phone }), 'otp_rate_limited');
    });

    it('caps sends within the sliding window', async () => {
      const phone = randomNgPhone();
      // Three sends are allowed per window. Age each just past the 60s resend
      // gap so all three remain inside the 15-minute window.
      for (let i = 0; i < 3; i += 1) {
        await requestOtp({ phone });
        await allowImmediateResend(phone, '70 seconds');
      }
      await expectFourError(requestOtp({ phone }), 'otp_rate_limited');
    });

    it('supersedes the previous challenge so attempts cannot be stockpiled', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });
      await allowImmediateResend(phone);
      await requestOtp({ phone });

      const live = await db.manyOrNone(
        `SELECT id FROM four_otp_challenges
          WHERE phone_e164 = $1 AND consumed_at IS NULL`,
        [phone]
      );
      expect(live.length).to.equal(1);
    });
  });

  describe('verify-otp', () => {
    it('creates a new user and returns a session', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });

      const result = await verifyOtp({ phone, code: STUB_CODE });

      expect(result.isNewUser).to.equal(true);
      expect(result.user.phoneNumber).to.equal(phone);
      expect(result.user.phoneVerified).to.equal(true);
      expect(result.session.token).to.be.a('string');
      expect(result.needsPin).to.equal(true);
      expect(result.needsProfile).to.equal(true);
    });

    it('creates the user with no email and no password', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });
      await verifyOtp({ phone, code: STUB_CODE });

      const row = await db.one<{ email: string | null; password: string | null }>(
        `SELECT email, password FROM users WHERE phone_e164 = $1`,
        [phone]
      );
      expect(row.email).to.equal(null);
      expect(row.password).to.equal(null);
    });

    it('signs an existing user back in without creating a second account', async () => {
      const phone = randomNgPhone();

      await requestOtp({ phone });
      const first = await verifyOtp({ phone, code: STUB_CODE });

      await allowImmediateResend(phone);
      await requestOtp({ phone });
      const second = await verifyOtp({ phone, code: STUB_CODE });

      expect(second.isNewUser).to.equal(false);
      expect(second.user.id).to.equal(first.user.id);

      const count = await db.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM users WHERE phone_e164 = $1`,
        [phone]
      );
      expect(count.n).to.equal('1');
    });

    it('resolves every spelling of the number to the SAME user', async () => {
      const phone = randomNgPhone();
      const nsn = phone.slice(4);
      const spellings = [`0${nsn}`, `234${nsn}`, phone, `+234 ${nsn}`];

      const ids: string[] = [];
      for (const spelling of spellings) {
        await allowImmediateResend(phone);
        await requestOtp({ phone: spelling });
        const result = await verifyOtp({ phone: spelling, code: STUB_CODE });
        ids.push(result.user.id);
      }

      expect(new Set(ids).size, 'all spellings must be one identity').to.equal(1);
    });

    it('rejects a wrong code and counts the attempt', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });

      await expectFourError(verifyOtp({ phone, code: '000000' }), 'otp_invalid');

      const row = await db.one<{ attempts: number }>(
        `SELECT attempts FROM four_otp_challenges
          WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`,
        [phone]
      );
      expect(row.attempts).to.equal(1);
    });

    it('locks the challenge after the attempt cap', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });

      for (let i = 0; i < 4; i += 1) {
        await expectFourError(
          verifyOtp({ phone, code: '000000' }),
          'otp_invalid'
        );
      }
      // 5th failure exhausts the cap.
      await expectFourError(
        verifyOtp({ phone, code: '000000' }),
        'otp_attempts_exceeded'
      );

      // The correct code no longer helps — a fresh code is required.
      await expectFourError(verifyOtp({ phone, code: STUB_CODE }), 'otp_invalid');
    });

    it('makes a verified code single-use', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });
      await verifyOtp({ phone, code: STUB_CODE });

      await expectFourError(verifyOtp({ phone, code: STUB_CODE }), 'otp_invalid');
    });

    it('rejects an expired challenge', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });
      await db.none(
        `UPDATE four_otp_challenges SET expires_at = NOW() - INTERVAL '1 minute'
          WHERE phone_e164 = $1`,
        [phone]
      );

      await expectFourError(verifyOtp({ phone, code: STUB_CODE }), 'otp_invalid');
    });

    it('rejects verification with no challenge at all', async () => {
      const phone = randomNgPhone();
      await expectFourError(verifyOtp({ phone, code: STUB_CODE }), 'otp_invalid');
    });

    it('rejects a malformed code without touching the challenge', async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });

      await expectFourError(verifyOtp({ phone, code: 'abc' }), 'otp_invalid');

      const row = await db.one<{ attempts: number }>(
        `SELECT attempts FROM four_otp_challenges
          WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`,
        [phone]
      );
      expect(row.attempts).to.equal(0);
    });
  });

  describe('sessions', () => {
    let userId: string;

    before(async () => {
      const phone = randomNgPhone();
      await requestOtp({ phone });
      const result = await verifyOtp({ phone, code: STUB_CODE });
      userId = result.user.id;
    });

    it('validates a freshly issued token', async () => {
      const issued = await createSession(userId, { platform: 'ios' });
      const session = await validateSessionToken(issued.token);
      expect(session?.userId).to.equal(userId);
    });

    it('stores only the hash, never the raw token', async () => {
      const issued = await createSession(userId);
      const row = await db.one<{ token_hash: string }>(
        `SELECT token_hash FROM four_sessions WHERE id = $1`,
        [issued.id]
      );
      expect(row.token_hash).to.not.equal(issued.token);
      expect(row.token_hash).to.have.length(64);
    });

    it('rejects an unknown token', async () => {
      expect(await validateSessionToken('fs_not-a-real-token')).to.equal(null);
    });

    it('rejects a malformed token', async () => {
      expect(await validateSessionToken('Bearer nonsense')).to.equal(null);
      expect(await validateSessionToken('')).to.equal(null);
    });

    it('rejects a revoked token', async () => {
      const issued = await createSession(userId);
      expect(await revokeSessionByToken(issued.token)).to.equal(true);
      expect(await validateSessionToken(issued.token)).to.equal(null);
    });

    it('rejects an expired token', async () => {
      const issued = await createSession(userId);
      await db.none(
        `UPDATE four_sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        [issued.id]
      );
      expect(await validateSessionToken(issued.token)).to.equal(null);
    });

    it('updates last_used_at on validation', async () => {
      const issued = await createSession(userId);
      await db.none(
        `UPDATE four_sessions SET last_used_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [issued.id]
      );
      await validateSessionToken(issued.token);

      const row = await db.one<{ stale: boolean }>(
        `SELECT (last_used_at < NOW() - INTERVAL '1 minute') AS stale
           FROM four_sessions WHERE id = $1`,
        [issued.id]
      );
      expect(row.stale).to.equal(false);
    });

    it('revokes every session for a user', async () => {
      const a = await createSession(userId);
      const b = await createSession(userId);
      const revoked = await revokeAllSessionsForUser(userId);

      expect(revoked).to.be.greaterThan(1);
      expect(await validateSessionToken(a.token)).to.equal(null);
      expect(await validateSessionToken(b.token)).to.equal(null);
      expect(await listActiveSessions(userId)).to.have.length(0);
    });

    it('issues distinct tokens', async () => {
      const a = await createSession(userId);
      const b = await createSession(userId);
      expect(a.token).to.not.equal(b.token);
    });
  });
});
