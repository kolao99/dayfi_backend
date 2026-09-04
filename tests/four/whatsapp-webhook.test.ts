/**
 * Azap WhatsApp adapter — Twilio webhook vertical slice.
 *
 * Run: npm run test:four-whatsapp
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';
process.env.FOUR_WHATSAPP_MODE = 'stub';
process.env.FOUR_WHATSAPP_SECURE_URL = 'https://www.dayfi.co';
process.env.AZAP_ASSISTANT_NAME = 'Azap';
process.env.WALLET_ENCRYPTION_KEY =
  process.env.WALLET_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import {
  drainStubWhatsappOutbound,
  resetStubWhatsappOutbound,
} from '../../src/modules/four/whatsapp/whatsappClient';
import { processWhatsappWebhook } from '../../src/modules/four/whatsapp/whatsappWebhookService';
import { parseTwilioInbound } from '../../src/modules/four/whatsapp/twilioProvider';
import PaymentService from '../../src/modules/payment/services';

const paymentService = new PaymentService();
const createdPhones: string[] = [];

async function makeWhatsappUserReady(phone: string): Promise<string> {
  const row = await db.one<{ user_id: string }>(
    `SELECT user_id FROM four_whatsapp_links WHERE whatsapp_phone_e164 = $1`,
    [phone]
  );
  await paymentService.ensureUserLedgerWallets(row.user_id);
  await db.none(`UPDATE users SET transaction_pin = 'hashed' WHERE user_id = $1`, [
    row.user_id,
  ]);
  await db.none(
    `UPDATE four_whatsapp_links
        SET metadata = '{"introShown": true}'::jsonb
      WHERE whatsapp_phone_e164 = $1`,
    [phone]
  );
  return row.user_id;
}

function randomNgWhatsappPhone(): string {
  const nsn = `80${crypto.randomInt(10_000_000, 99_999_999)}`;
  const phone = `+234${nsn}`;
  createdPhones.push(phone);
  return phone;
}

describe('four: whatsapp adapter', function () {
  this.timeout(30000);

  before(() => {
    resetStubWhatsappOutbound();
  });

  after(async () => {
    if (createdPhones.length > 0) {
      await db.none(
        `DELETE FROM users
          WHERE user_id IN (
            SELECT user_id FROM four_whatsapp_links
             WHERE whatsapp_phone_e164 = ANY($1::text[])
          )`,
        [createdPhones]
      );
      await db.none(
        `DELETE FROM four_whatsapp_links WHERE whatsapp_phone_e164 = ANY($1::text[])`,
        [createdPhones]
      );
    }
  });

  it('parses Twilio WhatsApp inbound payloads', () => {
    const parsed = parseTwilioInbound({
      From: 'whatsapp:+2348012345678',
      To: 'whatsapp:+14155238886',
      Body: 'Hey Azap',
      MessageSid: 'SM123',
      ProfileName: 'Kola',
    });

    expect(parsed?.fromPhoneE164).to.equal('+2348012345678');
    expect(parsed?.body).to.equal('Hey Azap');
    expect(parsed?.profileName).to.equal('Kola');
  });

  it('welcomes new WhatsApp users without OTP', async () => {
    resetStubWhatsappOutbound();
    const phone = randomNgWhatsappPhone();

    const result = await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: 'Hey',
      MessageSid: `SM-${Date.now()}`,
      ProfileName: 'Kolawole',
    });

    expect(result.ok).to.equal(true);

    const outbound = drainStubWhatsappOutbound();
    expect(outbound[0].text).to.include('Welcome to Azap');
    expect(outbound[0].text).to.include('Azap by Dayfi');
    expect(outbound[0].text).to.not.match(/\bMONY\b/i);
    expect(outbound[0].text).to.include('Kolawole');
    expect(outbound[0].buttons?.[0]?.id).to.equal('create_wallet');
  });

  it('routes balance queries through the shared engine', async () => {
    resetStubWhatsappOutbound();
    const phone = randomNgWhatsappPhone();

    await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: 'Hey',
      MessageSid: `SM-${Date.now()}-a`,
      ProfileName: 'Tester',
    });
    drainStubWhatsappOutbound();

    await makeWhatsappUserReady(phone);

    await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: "What's my balance?",
      MessageSid: `SM-${Date.now()}-b`,
    });

    const outbound = drainStubWhatsappOutbound();
    expect(outbound[0].text.toLowerCase()).to.match(/balance|fund/);
  });

  it('offers secure PIN sheet CTA after create wallet', async () => {
    resetStubWhatsappOutbound();
    const phone = randomNgWhatsappPhone();

    await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: 'Hey',
      MessageSid: `SM-${Date.now()}-e0`,
      ProfileName: 'Tester',
    });
    drainStubWhatsappOutbound();

    await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: 'Create wallet',
      MessageSid: `SM-${Date.now()}-e1`,
      ButtonPayload: 'create_wallet',
    });

    const prompt = drainStubWhatsappOutbound();
    expect(prompt[0].text.toLowerCase()).to.include('pin');
    expect(prompt[0].text).to.not.match(/\bMONY\b/i);
    expect(prompt[0].ctaUrl || '').to.include('/setup-pin');
    expect(prompt[0].ctaLabel || '').to.match(/pin/i);
  });

  it('routes /kyc through the shared engine', async () => {
    resetStubWhatsappOutbound();
    const phone = randomNgWhatsappPhone();

    await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: 'Hey',
      MessageSid: `SM-${Date.now()}-c`,
    });
    drainStubWhatsappOutbound();

    await makeWhatsappUserReady(phone);

    await processWhatsappWebhook({
      From: `whatsapp:${phone}`,
      To: 'whatsapp:+14155238886',
      Body: '/kyc',
      MessageSid: `SM-${Date.now()}-d`,
    });

    const outbound = drainStubWhatsappOutbound();
    expect(outbound[0].text.toLowerCase()).to.match(/verify|identity|bvn/);
  });
});
