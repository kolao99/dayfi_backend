/**
 * Four Phase 3 — Telegram vertical slice (balance + send intent).
 *
 * Run: npm run test:four-slice
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';
process.env.FOUR_TELEGRAM_MODE = 'stub';

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { resetOtpProviderCache } from '../../src/modules/four/auth/otpProvider';
import { requestOtp, verifyOtp } from '../../src/modules/four/auth/phoneAuthService';
import { createConversation } from '../../src/modules/four/conversation/conversationService';
import { handleUserText } from '../../src/modules/four/engine/conversationEngine';
import { linkTelegramUser } from '../../src/modules/four/telegram/telegramLinkService';
import {
  drainStubOutbound,
  resetStubOutbound,
} from '../../src/modules/four/telegram/telegramClient';
import { processTelegramUpdate } from '../../src/modules/four/telegram/telegramWebhookService';
import { upsertSavedRecipient } from '../../src/modules/payment/savedRecipientService';
import { getActiveIntentForConversation } from '../../src/modules/four/intent/intentService';
import HashText from '../../src/shared/services/hashing';
import PaymentService from '../../src/modules/payment/services';
import { creditUsdBalance } from '../../src/modules/payment/balanceService';

const paymentService = new PaymentService();

const STUB_CODE = '123456';
const createdPhones: string[] = [];

function randomNgPhone(): string {
  const nsn = `80${crypto.randomInt(10_000_000, 99_999_999)}`;
  const phone = `+234${nsn}`;
  createdPhones.push(phone);
  return phone;
}

async function createLinkedUser(): Promise<{
  userId: string;
  telegramUserId: number;
}> {
  const phone = randomNgPhone();
  await requestOtp({ phone });
  const auth = await verifyOtp({ phone, code: STUB_CODE });
  const telegramUserId = crypto.randomInt(100_000_000, 999_999_999);
  await linkTelegramUser({
    userId: auth.user.id,
    telegramUserId,
    chatId: telegramUserId,
  });
  return { userId: auth.user.id, telegramUserId };
}

async function fundUser(userId: string): Promise<void> {
  await paymentService.ensureUserLedgerWallets(userId);
  const wallet = await paymentService.getWalletByCurrency(userId, 'USD');
  if (!wallet) throw new Error('USD wallet missing');
  await creditUsdBalance({
    userId,
    walletId: wallet.wallet_id,
    amount: 500,
    fromCurrency: 'USD',
    source: 'manual',
    idempotencyKey: `test-fund-${userId}-${Date.now()}`,
    externalReference: `test-fund-${userId}`,
    metadata: { test: true },
  });
}

describe('four: vertical slice', function () {
  this.timeout(30000);

  before(() => {
    resetOtpProviderCache();
    resetStubOutbound();
  });

  after(async () => {
    if (createdPhones.length > 0) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        createdPhones,
      ]);
    }
  });

  it('answers balance queries', async () => {
    const { userId } = await createLinkedUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: "What's my balance?",
    });

    expect(result.replies).to.have.length(1);
    expect(result.replies[0].content.toLowerCase()).to.match(/balance|fund/);
  });

  it('creates a send intent when recipient and amount are known', async () => {
    const { userId } = await createLinkedUser();
    await fundUser(userId);
    const conversation = await createConversation(userId);

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

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Send 20k to Kola',
    });

    expect(result.intentId).to.be.a('string');
    expect(result.replies[0].content).to.include('Kola');
    expect(result.replies[0].content).to.include('20,000');

    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect(intent?.status).to.equal('AWAITING_CONFIRMATION');
    expect((intent?.slots as any).amount).to.equal(20000);
  });

  it('updates amount on pivot ("make it 15k")', async () => {
    const { userId } = await createLinkedUser();
    await fundUser(userId);
    const conversation = await createConversation(userId);

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

    await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Send 20k to Kola',
    });

    const updated = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Make it 15k',
    });

    expect(updated.replies[0].content).to.include('15,000');
    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect((intent?.slots as any).amount).to.equal(15000);
  });

  it('processes Telegram webhook for linked users', async () => {
    resetStubOutbound();
    const { telegramUserId } = await createLinkedUser();

    await processTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: telegramUserId, first_name: 'Test' },
        chat: { id: telegramUserId, type: 'private' },
        text: "What's my balance?",
      },
    });

    const outbound = drainStubOutbound();
    expect(outbound.length).to.be.greaterThan(0);
    expect(outbound[0].text.toLowerCase()).to.match(/balance|fund/);
  });

  it('prompts unlinked Telegram users to verify', async () => {
    resetStubOutbound();
    const strangerId = crypto.randomInt(100_000_000, 999_999_999);

    await processTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: strangerId, first_name: 'Stranger' },
        chat: { id: strangerId, type: 'private' },
        text: 'Hi',
      },
    });

    const outbound = drainStubOutbound();
    expect(outbound[0].text.toLowerCase()).to.include('link');
  });

  it('rejects invalid PIN on authorize', async () => {
    const { userId } = await createLinkedUser();
    await fundUser(userId);
    const conversation = await createConversation(userId);
    const pinHash = await HashText.hash('1234');
    await db.none(`UPDATE users SET transaction_pin = $2 WHERE user_id = $1`, [
      userId,
      pinHash,
    ]);

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

    const flow = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Send 20k to Kola',
    });

    const { getIntentForMiniApp } = await import(
      '../../src/modules/four/intent/miniAppService'
    );
    await getIntentForMiniApp(userId, flow.intentId!);

    const { authorizeIntentWithPin } = await import(
      '../../src/modules/four/intent/authorizeService'
    );

    try {
      await authorizeIntentWithPin({
        userId,
        intentId: flow.intentId!,
        pin: '9999',
      });
      expect.fail('expected pin_invalid');
    } catch (err: any) {
      expect(err.code).to.equal('pin_invalid');
    }
  });
});
