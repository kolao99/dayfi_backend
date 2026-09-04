/**
 * CEO WhatsApp 14yo E2E — run inside deploy-api:
 *   docker exec deploy-api-1 node /app/scripts/whatsapp-ceo-14yo-e2e.cjs
 */
const { db } = require('../dist/src/config/database');
const PaymentService = require('../dist/src/modules/payment/services').default;
const { creditUsdBalance } = require('../dist/src/modules/payment/balanceService');
const { setupTransactionPin } = require('../dist/src/modules/four/security/pinSetupService');
const { resolveWhatsappSession } = require('../dist/src/modules/four/whatsapp/whatsappIdentityService');
const { routeWhatsappText } = require('../dist/src/modules/four/whatsapp/whatsappRouter');
const { authorizeIntentWithPin } = require('../dist/src/modules/four/intent/authorizeService');
const {
  upsertActiveIntent,
} = require('../dist/src/modules/four/intent/intentService');
const { getLatestConversation } = require('../dist/src/modules/four/conversation/conversationService');
const { billsService } = require('../dist/src/modules/payment/billsService');
const { beginBillPayment } = require('../dist/src/modules/four/finance/billPaymentFlow');

const CEO_PHONE = process.env.CEO_WHATSAPP_PHONE || '+2348131208415';
const PIN = process.env.CEO_TEST_PIN || '2468';
const paymentService = new PaymentService();

async function say(userId, phone, text) {
  console.log(`\n>>> USER: ${text}`);
  await routeWhatsappText({
    userId,
    phoneE164: phone,
    text,
    firstName: 'Friend',
    inboundMessageId: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  await new Promise((r) => setTimeout(r, 1500));
}

async function fund(userId, usd) {
  await paymentService.ensureUserLedgerWallets(userId);
  const wallet = await paymentService.getWalletByCurrency(userId, 'USD');
  if (!wallet) throw new Error('no USD wallet');
  await creditUsdBalance({
    userId,
    walletId: wallet.wallet_id,
    amount: usd,
    fromCurrency: 'USD',
    source: 'manual',
    idempotencyKey: `ceo-e2e-fund-${userId}-${Date.now()}`,
    externalReference: `ceo-e2e-${Date.now()}`,
    metadata: { e2e: true },
  });
}

async function ensurePin(userId) {
  const row = await db.oneOrNone(
    `SELECT transaction_pin FROM users WHERE user_id = $1`,
    [userId]
  );
  if (row && row.transaction_pin) return;
  try {
    await setupTransactionPin({ userId, pin: PIN, confirmPin: PIN });
  } catch (_e) {
    await db.none(
      `UPDATE users SET transaction_pin = NULL WHERE user_id = $1`,
      [userId]
    );
    await setupTransactionPin({ userId, pin: PIN, confirmPin: PIN });
  }
}

async function verifyKyc(userId) {
  await db.none(
    `UPDATE users SET bvn = '22345678901', level = 'level-2',
      email = COALESCE(NULLIF(email,''), 'ceo-e2e@dayfi.co')
     WHERE user_id = $1`,
    [userId]
  );
}

async function payBillCategory(userId, conversationId, category, customerId, amount) {
  console.log(`\n=== BILL ${category} ===`);
  try {
    await beginBillPayment({
      userId,
      conversationId,
      categoryCode: category,
      text: `${category} ${amount}`,
    });
  } catch (e) {
    console.log('begin warn', e.message || e);
  }

  const slots = { categoryCode: category, customerId, amount };

  if (category === 'AIRTIME' || category === 'MOBILEDATA') {
    slots.billerCode = 'BIL099';
    slots.itemCode = 'AT099';
    slots.billerName = category === 'AIRTIME' ? 'Airtime' : 'Data';
    slots.itemName = slots.billerName;
  } else {
    try {
      const billers = await billsService.getBillers(category);
      const biller = Array.isArray(billers) ? billers[0] : null;
      if (!biller || !biller.biller_code) {
        console.log(`SKIP ${category}: no billers`);
        return { ok: false, reason: 'no_billers' };
      }
      slots.billerCode = biller.biller_code;
      slots.billerName = biller.name || category;
      const items = await billsService.getItems(String(biller.biller_code));
      slots.itemCode =
        (Array.isArray(items) && items[0] && items[0].item_code) || 'UNKNOWN';
      slots.itemName =
        (Array.isArray(items) && items[0] && items[0].biller_name) ||
        slots.billerName;
    } catch (err) {
      console.log(`SKIP ${category}:`, err.message || err);
      return { ok: false, reason: String(err.message || err) };
    }
  }

  const intent = await upsertActiveIntent({
    userId,
    conversationId,
    intent: 'PAY_BILL',
    status: 'AWAITING_AUTHORIZATION',
    slots,
  });

  try {
    const result = await authorizeIntentWithPin({
      userId,
      intentId: intent.id,
      pin: PIN,
    });
    console.log('PAY OK:', String(result.execution.message).slice(0, 240));
    return { ok: true, message: result.execution.message };
  } catch (err) {
    console.log('PAY FAIL:', err.message || err);
    return { ok: false, reason: String(err.message || err) };
  }
}

async function main() {
  console.log('CEO WhatsApp 14yo E2E starting for', CEO_PHONE);
  const session = await resolveWhatsappSession({
    phoneE164: CEO_PHONE,
    profileName: 'CEO Tester',
  });
  const userId = session.user.user_id;
  console.log('userId', userId);

  await verifyKyc(userId);
  await ensurePin(userId);
  await fund(userId, 50);

  await say(userId, CEO_PHONE, 'Hey');
  await say(userId, CEO_PHONE, "What's my balance?");
  await say(userId, CEO_PHONE, 'How much do I have in naira?');
  await say(userId, CEO_PHONE, 'How can someone send me money?');
  await say(userId, CEO_PHONE, 'Fund my wallet');
  await say(userId, CEO_PHONE, 'Send Kola KES 2000');
  await say(userId, CEO_PHONE, 'show my transactions');
  await say(userId, CEO_PHONE, 'swap 10 USDC to EURC');

  const conversation = await getLatestConversation(userId);
  if (!conversation) throw new Error('no conversation');

  const billResults = {};
  billResults.AIRTIME = await payBillCategory(
    userId,
    conversation.id,
    'AIRTIME',
    '08131208415',
    100
  );
  for (const cat of ['MOBILEDATA', 'UTILITYBILLS', 'INTSERVICE', 'CABLEBILLS']) {
    billResults[cat] = await payBillCategory(
      userId,
      conversation.id,
      cat,
      cat === 'MOBILEDATA' ? '08131208415' : '0000000000',
      100
    );
  }

  console.log('\n=== BILL SUMMARY ===');
  console.log(JSON.stringify(billResults, null, 2));
  console.log('Done — check CEO WhatsApp for pushed replies.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
