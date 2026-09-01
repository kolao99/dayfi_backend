/**
 * Four Mini App — intent fetch + PIN authorize via Telegram WebApp stub auth.
 *
 * Run: npm run test:four-miniapp
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';
process.env.FOUR_TELEGRAM_MODE = 'stub';
process.env.FOUR_TELEGRAM_WEBAPP_STUB = 'true';

import chai from 'chai';
import chaiHttp from 'chai-http';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import app from '../../src/config/express';
import { db } from '../../src/config/database';
import { resetOtpProviderCache } from '../../src/modules/four/auth/otpProvider';
import { requestOtp, verifyOtp } from '../../src/modules/four/auth/phoneAuthService';
import { linkTelegramUser } from '../../src/modules/four/telegram/telegramLinkService';
import { createConversation } from '../../src/modules/four/conversation/conversationService';
import { handleUserText } from '../../src/modules/four/engine/conversationEngine';
import { upsertSavedRecipient } from '../../src/modules/payment/savedRecipientService';
import PaymentService from '../../src/modules/payment/services';
import { creditUsdBalance } from '../../src/modules/payment/balanceService';
import HashText from '../../src/shared/services/hashing';

chai.use(chaiHttp);
const { expect } = chai;

const STUB_CODE = '123456';
const paymentService = new PaymentService();
const createdPhones: string[] = [];

function randomNgPhone(): string {
  const nsn = `80${crypto.randomInt(10_000_000, 99_999_999)}`;
  const phone = `+234${nsn}`;
  createdPhones.push(phone);
  return phone;
}

async function setupSendIntent(): Promise<{
  userId: string;
  telegramUserId: number;
  intentId: string;
}> {
  const phone = randomNgPhone();
  await requestOtp({ phone });
  const auth = await verifyOtp({ phone, code: STUB_CODE });
  const userId = auth.user.id;
  const telegramUserId = crypto.randomInt(100_000_000, 999_999_999);

  await linkTelegramUser({ userId, telegramUserId, chatId: telegramUserId });

  await paymentService.ensureUserLedgerWallets(userId);
  const wallet = await paymentService.getWalletByCurrency(userId, 'USD');
  await creditUsdBalance({
    userId,
    walletId: wallet!.wallet_id,
    amount: 500,
    fromCurrency: 'USD',
    source: 'manual',
    idempotencyKey: `miniapp-fund-${userId}`,
    externalReference: `miniapp-fund-${userId}`,
  });

  await upsertSavedRecipient(userId, {
    name: 'Kola',
    country: 'NG',
    ledgerCurrency: 'NGN',
    source: {
      accountType: 'bank',
      accountNumber: '8012345678',
      networkId: '035',
    },
  });

  const conversation = await createConversation(userId);
  const flow = await handleUserText({
    userId,
    conversationId: conversation.id,
    text: 'Send 20k to Kola',
  });

  return {
    userId,
    telegramUserId,
    intentId: flow.intentId!,
  };
}

describe('four: mini app authorization', function () {
  this.timeout(60000);

  before(() => resetOtpProviderCache());

  after(async () => {
    if (createdPhones.length > 0) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        createdPhones,
      ]);
    }
  });

  it('GET /intents/:id promotes to AWAITING_AUTHORIZATION with stub telegram auth', async () => {
    const { telegramUserId, intentId } = await setupSendIntent();

    const res = await chai
      .request(app)
      .get(`/api/v1/four/intents/${intentId}`)
      .set('X-Telegram-Stub-User-Id', String(telegramUserId));

    expect(res.status).to.equal(200);
    expect(res.body.data.intent.status).to.equal('AWAITING_AUTHORIZATION');
    expect(res.body.data.intent.slots.amount).to.equal(20000);
    expect(res.body.data.intent.slots.recipient.name).to.equal('Kola');
    expect(String(res.body.data.intent.slots.recipient.accountNumber)).to.include(
      '••••'
    );
  });

  it('rejects authorize with wrong PIN', async () => {
    const { userId, telegramUserId, intentId } = await setupSendIntent();
    const pinHash = await HashText.hash('1234');
    await db.none(`UPDATE users SET transaction_pin = $2 WHERE user_id = $1`, [
      userId,
      pinHash,
    ]);

    await chai
      .request(app)
      .get(`/api/v1/four/intents/${intentId}`)
      .set('X-Telegram-Stub-User-Id', String(telegramUserId));

    const res = await chai
      .request(app)
      .post(`/api/v1/four/intents/${intentId}/authorize`)
      .set('X-Telegram-Stub-User-Id', String(telegramUserId))
      .send({ pin: '9999' });

    expect(res.status).to.equal(400);
    expect(res.body.message).to.match(/PIN/i);
  });

  it('rejects unlinked telegram users', async () => {
    const { intentId } = await setupSendIntent();
    const stranger = crypto.randomInt(100_000_000, 999_999_999);

    const res = await chai
      .request(app)
      .get(`/api/v1/four/intents/${intentId}`)
      .set('X-Telegram-Stub-User-Id', String(stranger));

    expect(res.status).to.equal(403);
  });
});
