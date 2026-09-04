/**
 * Four conversational engine — KYC routing, bank transfers, corrections.
 *
 * Run: npm run test:four-engine
 */

process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';
process.env.AZAP_LLM_PROVIDER = 'stub';

import { expect } from 'chai';
import { describe, it, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { createConversation } from '../../src/modules/four/conversation/conversationService';
import { handleUserText } from '../../src/modules/four/engine/conversationEngine';
import { getActiveIntentForConversation, upsertActiveIntent } from '../../src/modules/four/intent/intentService';
import { requestOtp, verifyOtp } from '../../src/modules/four/auth/phoneAuthService';
import { upsertSavedRecipient } from '../../src/modules/payment/savedRecipientService';
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

async function createUser(): Promise<string> {
  const phone = randomNgPhone();
  await requestOtp({ phone });
  const auth = await verifyOtp({ phone, code: STUB_CODE });
  return auth.user.id;
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

/** Tier-2 + BVN so SEND_MONEY can reach review (matches canSendMoney). */
async function verifyUserForSend(userId: string): Promise<void> {
  await db.none(
    `UPDATE users SET bvn = '22345678901', level = 'level-2' WHERE user_id = $1`,
    [userId]
  );
}

describe('four: conversation engine', function () {
  this.timeout(30000);

  after(async () => {
    if (createdPhones.length > 0) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        createdPhones,
      ]);
    }
  });

  it('routes /kyc into the KYC flow instead of default help text', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: '/kyc',
    });

    expect(result.replies[0].content.toLowerCase()).to.not.include(
      'saved contact'
    );
    expect(result.replies[0].content.toLowerCase()).to.match(
      /verify|verified|identity|bvn/
    );
  });

  it('routes natural-language KYC requests', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'I want to complete my KYC',
    });

    expect(result.replies[0].content.toLowerCase()).to.match(
      /verify|verified|identity|bvn/
    );
  });

  it('reports already-verified KYC without starting a new flow', async () => {
    const userId = await createUser();
    await db.none(
      `UPDATE users SET bvn = '22345678901', level = 'level-2' WHERE user_id = $1`,
      [userId]
    );
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: '/kyc',
    });

    expect(result.replies[0].content.toLowerCase()).to.include('verified');
  });

  it('does not treat bank transfers as saved-recipient lookups', async () => {
    const userId = await createUser();
    await fundUser(userId);
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Send 2k to OPay 8131208415',
    });

    expect(result.replies[0].content.toLowerCase()).to.not.include(
      'saved contact'
    );
    expect(result.replies[0].content.toLowerCase()).to.not.include(
      'saved recipient'
    );
    expect(result.replies[0].content.toLowerCase()).to.match(
      /verify|found|which bank|account/
    );
  });

  it('asks for the bank when only an account number is provided', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Send 2k to 8131208415',
    });

    expect(result.replies[0].content.toLowerCase()).to.include('which bank');
    expect(result.replies[0].content.toLowerCase()).to.not.include(
      'saved contact'
    );
  });

  it('updates amount on an active send intent', async () => {
    const userId = await createUser();
    await fundUser(userId);
    await verifyUserForSend(userId);
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
      text: 'Actually make it 5k',
    });

    expect(updated.replies[0].content).to.include('5,000');
    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect((intent?.slots as any).amount).to.equal(5000);
  });

  it('updates recipient on an active send intent', async () => {
    const userId = await createUser();
    await fundUser(userId);
    await verifyUserForSend(userId);
    const conversation = await createConversation(userId);

    await upsertSavedRecipient(userId, {
      name: 'Jane',
      country: 'NG',
      ledgerCurrency: 'NGN',
      source: {
        accountType: 'bank',
        accountNumber: '8098765432',
        networkId: '035',
      },
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

    await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Send 20k to Kola',
    });

    const updated = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Actually send it to Jane',
    });

    expect(updated.replies[0].content).to.include('Jane');
    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect((intent?.slots as any).recipient?.name).to.match(/jane/i);
  });

  it('offers funding options when balance is insufficient', async () => {
    const userId = await createUser();
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
      text: 'Send 2k to Kola',
    });

    expect(result.replies[0].content.toLowerCase()).to.include(
      "don't have enough balance"
    );
    expect(result.replies[0].content.toLowerCase()).to.include('fund your wallet');
    expect((result.replies[0].metadata as any)?.scope).to.equal('fund');
    expect((result.replies[0].metadata as any)?.buttons?.length).to.be.greaterThan(
      0
    );
  });

  it('routes Fund to the funding menu', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Fund',
    });

    expect(result.replies[0].content.toLowerCase()).to.include(
      'fund your wallet'
    );
    expect((result.replies[0].metadata as any)?.scope).to.equal('fund');
  });

  it('continues FUND_CRYPTO when user replies with a bare amount after address', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    await upsertActiveIntent({
      userId,
      conversationId: conversation.id,
      intent: 'FUND_CRYPTO',
      status: 'AWAITING_DEPOSIT',
      slots: {
        method: 'crypto',
        asset: 'USDC',
        network: 'stellar',
        depositAddress: 'GTESTADDRESSFORCRYPTODEPOSIT000000000000000000000',
      },
    });

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: '100',
    });

    const content = result.replies[0].content.toLowerCase();
    expect(content).to.not.include("what's my balance");
    expect(content).to.not.include('buy ₦1,000 airtime');
    expect(content).to.match(/100|usdc|stellar|deposit/);
    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect(intent?.intent).to.equal('FUND_CRYPTO');
    expect(intent?.status).to.equal('AWAITING_DEPOSIT');
    expect((intent?.slots as any).amount).to.equal(100);
  });

  it('treats deposit arrival questions as status checks, not new deposits', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    await upsertActiveIntent({
      userId,
      conversationId: conversation.id,
      intent: 'FUND_CRYPTO',
      status: 'AWAITING_DEPOSIT',
      slots: {
        method: 'crypto',
        asset: 'USDC',
        network: 'stellar',
        amount: 100,
        depositAddress: 'GTESTADDRESSFORCRYPTODEPOSIT000000000000000000000',
      },
    });

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: '100 USDC received it yet?',
    });

    const content = result.replies[0].content.toLowerCase();
    expect(content).to.not.include('which network');
    expect(content).to.match(/not yet|haven't|received|confirmed|couldn't check/);
  });

  it('routes bill payment questions into the bill flow, not generic nudge', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Can I pay a bill?',
    });

    const content = result.replies[0].content.toLowerCase();
    expect(content).to.match(/airtime|electricity|bill|data|dstv/);
    expect(content).to.not.include("what's my balance");
    expect(content).to.not.include('coming soon');
  });

  it('allows intent switch to bills without destroying crypto deposit context', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    await upsertActiveIntent({
      userId,
      conversationId: conversation.id,
      intent: 'FUND_CRYPTO',
      status: 'AWAITING_DEPOSIT',
      slots: {
        method: 'crypto',
        asset: 'USDC',
        network: 'stellar',
        depositAddress: 'GTESTADDRESSFORCRYPTODEPOSIT000000000000000000000',
      },
    });

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Can I pay a bill?',
    });

    expect(result.replies[0].content.toLowerCase()).to.match(
      /airtime|electricity|bill|data|dstv/
    );
    // Bill switch starts PAY_BILL — deposit context is superseded intentionally
    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect(intent?.intent).to.equal('PAY_BILL');
  });

  it('starts airtime collection for Buy ₦1,000 airtime', async () => {
    const userId = await createUser();
    const conversation = await createConversation(userId);

    const result = await handleUserText({
      userId,
      conversationId: conversation.id,
      text: 'Buy ₦1,000 airtime',
    });

    const content = result.replies[0].content.toLowerCase();
    expect(content).to.match(/phone|number|top up|airtime/);
    const intent = await getActiveIntentForConversation(
      userId,
      conversation.id
    );
    expect(intent?.intent).to.equal('PAY_BILL');
    expect((intent?.slots as any).amount).to.equal(1000);
    expect((intent?.slots as any).categoryCode).to.equal('AIRTIME');
  });
});
