/**
 * Four Phase 2 — conversations and messages.
 *
 * Run: npm run test:four-conversations
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { resetOtpProviderCache } from '../../src/modules/four/auth/otpProvider';
import { requestOtp, verifyOtp } from '../../src/modules/four/auth/phoneAuthService';
import {
  createConversation,
  getConversationForUser,
  getLatestConversation,
  listConversations,
} from '../../src/modules/four/conversation/conversationService';
import {
  appendMessage,
  listMessages,
} from '../../src/modules/four/conversation/messageService';

const STUB_CODE = '123456';
const createdPhones: string[] = [];

function randomNgPhone(): string {
  const nsn = `80${crypto.randomInt(10_000_000, 99_999_999)}`;
  const phone = `+234${nsn}`;
  createdPhones.push(phone);
  return phone;
}

async function createUser(): Promise<{ userId: string; phone: string }> {
  const phone = randomNgPhone();
  await requestOtp({ phone });
  const result = await verifyOtp({ phone, code: STUB_CODE });
  return { userId: result.user.id, phone };
}

describe('four: conversations', function () {
  this.timeout(30000);

  before(() => resetOtpProviderCache());

  after(async () => {
    if (createdPhones.length > 0) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        createdPhones,
      ]);
    }
  });

  it('creates a conversation for a user', async () => {
    const { userId } = await createUser();
    const conversation = await createConversation(userId, 'Test chat');
    expect(conversation.user_id).to.equal(userId);
    expect(conversation.title).to.equal('Test chat');
  });

  it('returns null latest conversation for a new user', async () => {
    const { userId } = await createUser();
    const latest = await getLatestConversation(userId);
    expect(latest).to.equal(null);
  });

  it('appends messages in stable seq order', async () => {
    const { userId } = await createUser();
    const conversation = await createConversation(userId);

    await appendMessage({
      userId,
      conversationId: conversation.id,
      role: 'user',
      type: 'text',
      content: 'Hello',
      clientMessageId: 'c1',
    });
    await appendMessage({
      userId,
      conversationId: conversation.id,
      role: 'assistant',
      type: 'text',
      content: 'Hi there',
    });

    const page = await listMessages(userId, conversation.id);
    expect(page).to.not.equal(null);
    expect(page!.messages).to.have.length(2);
    expect(page!.messages[0].content).to.equal('Hello');
    expect(page!.messages[1].content).to.equal('Hi there');
    expect(Number(page!.messages[1].seq)).to.be.greaterThan(
      Number(page!.messages[0].seq)
    );
  });

  it('deduplicates by clientMessageId on retry', async () => {
    const { userId } = await createUser();
    const conversation = await createConversation(userId);

    const first = await appendMessage({
      userId,
      conversationId: conversation.id,
      role: 'user',
      type: 'text',
      content: 'Once',
      clientMessageId: 'dedupe-1',
    });
    const second = await appendMessage({
      userId,
      conversationId: conversation.id,
      role: 'user',
      type: 'text',
      content: 'Once',
      clientMessageId: 'dedupe-1',
    });

    expect(first!.deduplicated).to.equal(false);
    expect(second!.deduplicated).to.equal(true);
    expect(first!.message.id).to.equal(second!.message.id);

    const page = await listMessages(userId, conversation.id);
    expect(page!.messages).to.have.length(1);
  });

  it('persists button metadata for persistent controls', async () => {
    const { userId } = await createUser();
    const conversation = await createConversation(userId);

    const metadata = {
      buttons: [
        { id: 'fund_crypto', label: 'Fund with Crypto', disabled: false },
        { id: 'fund_bank', label: 'Bank transfer', disabled: false },
      ],
    };

    await appendMessage({
      userId,
      conversationId: conversation.id,
      role: 'assistant',
      type: 'choice',
      content: 'How would you like to fund your wallet?',
      metadata,
    });

    const page = await listMessages(userId, conversation.id);
    const msg = page!.messages[0];
    expect(msg.type).to.equal('choice');
    expect((msg.metadata as any).buttons).to.have.length(2);

    await appendMessage({
      userId,
      conversationId: conversation.id,
      role: 'assistant',
      type: 'choice',
      content: 'How would you like to fund your wallet?',
      metadata: {
        buttons: [
          { id: 'fund_crypto', label: 'Fund with Crypto', disabled: true },
          { id: 'fund_bank', label: 'Bank transfer', disabled: false },
        ],
      },
    });

    const updated = await listMessages(userId, conversation.id, { limit: 10 });
    const latest = updated!.messages[updated!.messages.length - 1];
    expect((latest.metadata as any).buttons[0].disabled).to.equal(true);
  });

  it('isolates conversations across users (404 semantics via null)', async () => {
    const userA = await createUser();
    const userB = await createUser();
    const conversation = await createConversation(userA.userId);

    const forbidden = await getConversationForUser(
      userB.userId,
      conversation.id
    );
    expect(forbidden).to.equal(null);

    const messages = await listMessages(userB.userId, conversation.id);
    expect(messages).to.equal(null);
  });

  it('lists conversations most-recent first', async () => {
    const { userId } = await createUser();
    const older = await createConversation(userId, 'Older');
    const newer = await createConversation(userId, 'Newer');

    await appendMessage({
      userId,
      conversationId: newer.id,
      role: 'user',
      type: 'text',
      content: 'ping',
    });

    const list = await listConversations(userId);
    expect(list[0].id).to.equal(newer.id);
    expect(list.some((c) => c.id === older.id)).to.equal(true);
  });
});
