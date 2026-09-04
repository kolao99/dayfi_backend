/**
 * Drive the CEO WhatsApp journey through the SAME path Meta uses:
 * resolveWhatsappSession → routeWhatsappText → deliverWhatsappReplies.
 *
 * Run on VPS inside deploy-api container:
 *   node dist/scripts/whatsapp-ceo-14yo-e2e.js
 *
 * Or from repo (ts-node) against local DB (replies may stub):
 *   npx ts-node -r dotenv/config scripts/whatsapp-ceo-14yo-e2e.ts
 */
import { db } from '../src/config/database';
import PaymentService from '../src/modules/payment/services';
import { creditUsdBalance } from '../src/modules/payment/balanceService';
import { setupTransactionPin } from '../src/modules/four/security/pinSetupService';
import { resolveWhatsappSession } from '../src/modules/four/whatsapp/whatsappIdentityService';
import { routeWhatsappText } from '../src/modules/four/whatsapp/whatsappRouter';
import { authorizeIntentWithPin } from '../src/modules/four/intent/authorizeService';
import { getActiveIntentForConversation } from '../src/modules/four/intent/intentService';
import { getLatestConversation } from '../src/modules/four/conversation/conversationService';
import { billsService } from '../src/modules/payment/billsService';
import { beginBillPayment } from '../src/modules/four/finance/billPaymentFlow';
import { upsertActiveIntent } from '../src/modules/four/intent/intentService';

const CEO_PHONE = process.env.CEO_WHATSAPP_PHONE || '+2348131208415';
const PIN = process.env.CEO_TEST_PIN || '2468';
const paymentService = new PaymentService();

async function say(userId: string, phone: string, text: string) {
  console.log(`\n>>> USER: ${text}`);
  await routeWhatsappText({
    userId,
    phoneE164: phone,
    text,
    firstName: 'Friend',
    inboundMessageId: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  await new Promise((r) => setTimeout(r, 800));
}

async function fund(userId: string, usd: number) {
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

async function ensurePin(userId: string) {
  const row = await db.oneOrNone<{ transaction_pin: string | null }>(
    `SELECT transaction_pin FROM users WHERE user_id = $1`,
    [userId]
  );
  if (row?.transaction_pin) return;
  try {
    await setupTransactionPin({ userId, pin: PIN });
  } catch {
    await db.none(
      `UPDATE users SET transaction_pin = NULL WHERE user_id = $1`,
      [userId]
    );
    await setupTransactionPin({ userId, pin: PIN });
  }
}

async function verifyKyc(userId: string) {
  await db.none(
    `UPDATE users SET bvn = '22345678901', level = 'level-2',
      email = COALESCE(NULLIF(email,''), 'ceo-e2e@dayfi.co')
     WHERE user_id = $1`,
    [userId]
  );
}

async function authorizeActiveIfReady(userId: string) {
  const conversation = await getLatestConversation(userId);
  if (!conversation) return null;
  const intent = await getActiveIntentForConversation(
    userId,
    conversation.id
  );
  if (!intent) return null;
  if (
    intent.status === 'AWAITING_CONFIRMATION' ||
    intent.status === 'AWAITING_AUTHORIZATION'
  ) {
    await upsertActiveIntent({
      userId,
      conversationId: conversation.id,
      intent: intent.intent as never,
      status: 'AWAITING_AUTHORIZATION',
      slots: intent.slots as Record<string, unknown>,
    });
    const result = await authorizeIntentWithPin({
      userId,
      intentId: intent.id,
      pin: PIN,
    });
    console.log('<<< PIN AUTH:', result.execution.message.slice(0, 200));
    return result;
  }
  return null;
}

async function payBillCategory(
  userId: string,
  conversationId: string,
  category: string,
  customerId: string,
  amount: number
) {
  console.log(`\n=== BILL ${category} ===`);
  const start = await beginBillPayment({
    userId,
    conversationId,
    categoryCode: category as never,
    text: `${category} ${amount}`,
  });
  console.log('begin:', start.content.slice(0, 160).replace(/\n/g, ' | '));

  // Force review slots for airtime-like categories
  const slots: Record<string, unknown> = {
    ...(typeof start.metadata === 'object' ? {} : {}),
    categoryCode: category,
    customerId,
    amount,
  };

  if (category === 'AIRTIME' || category === 'MOBILEDATA') {
    slots.billerCode = 'BIL099';
    slots.itemCode = 'AT099';
    slots.billerName = category === 'AIRTIME' ? 'Airtime' : 'Data';
    slots.itemName = slots.billerName;
  } else {
    try {
      const billers = (await billsService.getBillers(category)) as Array<{
        biller_code?: string;
        name?: string;
      }>;
      const biller = billers?.[0];
      if (!biller?.biller_code) {
        console.log(`SKIP ${category}: no billers from FLW`);
        return { ok: false, reason: 'no_billers' };
      }
      slots.billerCode = biller.biller_code;
      slots.billerName = biller.name || category;
      const items = (await billsService.getItems(String(biller.biller_code))) as Array<{
        item_code?: string;
        biller_name?: string;
      }>;
      slots.itemCode = items?.[0]?.item_code || 'UNKNOWN';
      slots.itemName = items?.[0]?.biller_name || slots.billerName;
    } catch (err) {
      console.log(
        `SKIP ${category}:`,
        err instanceof Error ? err.message : err
      );
      return { ok: false, reason: 'catalog_error' };
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
    console.log('PAY OK:', result.execution.message.slice(0, 240));
    return { ok: true, message: result.execution.message };
  } catch (err) {
    console.log(
      'PAY FAIL:',
      err instanceof Error ? err.message : err
    );
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log('CEO WhatsApp 14yo E2E starting for', CEO_PHONE);

  const session = await resolveWhatsappSession({
    phoneE164: CEO_PHONE,
    profileName: 'CEO Tester',
  });
  const userId = session.user.user_id;
  console.log('userId', userId, 'new?', session.isNewUser);

  await verifyKyc(userId);
  await ensurePin(userId);
  await fund(userId, 50);

  // Conversational WhatsApp path (pushes to Meta if configured)
  await say(userId, CEO_PHONE, 'Hey');
  await say(userId, CEO_PHONE, "What's my balance?");
  await say(userId, CEO_PHONE, 'How much do I have in naira?');
  await say(userId, CEO_PHONE, 'How can someone send me money?');
  await say(userId, CEO_PHONE, 'Fund my wallet');
  await say(userId, CEO_PHONE, 'Give me my USDC address');
  await say(userId, CEO_PHONE, 'Send Kola KES 2000');
  await say(userId, CEO_PHONE, 'show my transactions');
  await say(userId, CEO_PHONE, 'swap 10 USDC to EURC');

  const conversation = await getLatestConversation(userId);
  if (!conversation) throw new Error('no conversation');

  const billResults: Record<string, unknown> = {};
  // Live FLW — small airtime to CEO MSISDN
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
  console.log('\nDone. Check CEO WhatsApp for conversational replies.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
