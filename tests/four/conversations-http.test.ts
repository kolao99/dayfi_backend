/**
 * Four Phase 2 — HTTP E2E for conversation routes.
 *
 * Run: npm run test:four-conversations-http
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';

import chai from 'chai';
import chaiHttp from 'chai-http';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import app from '../../src/config/express';
import { db } from '../../src/config/database';
import { resetOtpProviderCache } from '../../src/modules/four/auth/otpProvider';

chai.use(chaiHttp);
const { expect } = chai;

const STUB_CODE = '123456';
const createdPhones: string[] = [];

function randomNgPhone(): string {
  const nsn = `80${crypto.randomInt(10_000_000, 99_999_999)}`;
  const phone = `+234${nsn}`;
  createdPhones.push(phone);
  return phone;
}

async function signIn(): Promise<string> {
  const phone = randomNgPhone();
  await chai
    .request(app)
    .post('/api/v1/four/auth/request-otp')
    .send({ phone });
  const res = await chai
    .request(app)
    .post('/api/v1/four/auth/verify-otp')
    .send({ phone, code: STUB_CODE });
  expect(res.status).to.equal(200);
  return res.body.data.session.token as string;
}

describe('four: conversations HTTP', function () {
  this.timeout(30000);

  before(() => resetOtpProviderCache());

  after(async () => {
    if (createdPhones.length > 0) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        createdPhones,
      ]);
    }
  });

  it('POST /conversations then GET /messages', async () => {
    const token = await signIn();

    const created = await chai
      .request(app)
      .post('/api/v1/four/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'HTTP test' });

    expect(created.status).to.equal(201);
    const conversationId = created.body.data.conversation.id as string;

    const posted = await chai
      .request(app)
      .post('/api/v1/four/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conversationId,
        role: 'user',
        type: 'text',
        content: 'What is my balance?',
        clientMessageId: 'http-msg-1',
      });

    expect(posted.status).to.equal(201);

    const listed = await chai
      .request(app)
      .get(`/api/v1/four/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(listed.status).to.equal(200);
    expect(listed.body.data.messages).to.have.length(1);
    expect(listed.body.data.messages[0].content).to.equal(
      'What is my balance?'
    );
  });

  it('GET /conversations/latest returns null for a new user', async () => {
    const token = await signIn();
    const res = await chai
      .request(app)
      .get('/api/v1/four/conversations/latest')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).to.equal(200);
    expect(res.body.data.conversation).to.equal(null);
  });
});
