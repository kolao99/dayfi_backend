/**
 * Reset a Four WhatsApp user so onboarding can start fresh.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/clear-four-whatsapp-user.ts +2348131208415
 *
 * Production Railway:
 *   CONFIRM_RAILWAY_CLEAR=yes npx ts-node -r dotenv/config scripts/clear-four-whatsapp-user.ts +2348131208415
 */
import { db } from '../src/config/database';
import { normalizePhoneE164 } from '../src/shared/utils/phoneE164';

function isRailwayHost(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('railway.app') ||
    u.includes('rlwy.net') ||
    u.includes('railway.internal')
  );
}

async function main() {
  const rawPhone = process.argv[2];
  if (!rawPhone) {
    console.error('Usage: clear-four-whatsapp-user.ts <phone-e164-or-ng-number>');
    process.exit(1);
  }

  const normalized = normalizePhoneE164(rawPhone);
  if (!normalized.ok) {
    console.error(`Invalid phone: ${normalized.reason}`);
    process.exit(1);
  }
  const phoneE164 = normalized.e164;

  const connectionString =
    process.env.DAYFI_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    '';
  if (!connectionString) {
    console.error('Set DAYFI_DATABASE_URL');
    process.exit(1);
  }

  if (
    isRailwayHost(connectionString) &&
    process.env.CONFIRM_RAILWAY_CLEAR !== 'yes'
  ) {
    console.error(
      'Refusing Railway clear without CONFIRM_RAILWAY_CLEAR=yes'
    );
    process.exit(1);
  }

  const hostHint = connectionString.replace(/:[^:@]+@/, ':***@');
  console.log(`Clearing Four WhatsApp user ${phoneE164} on ${hostHint}`);

  const link = await db.oneOrNone<{ user_id: string }>(
    `SELECT user_id FROM four_whatsapp_links WHERE whatsapp_phone_e164 = $1`,
    [phoneE164]
  );

  if (!link) {
    console.log('No four_whatsapp_links row — nothing to clear.');
    process.exit(0);
  }

  const userId = link.user_id;
  console.log(`  user_id: ${userId}`);

  await db.tx(async (t) => {
    await t.none(`DELETE FROM four_messages WHERE user_id = $1`, [userId]);
    await t.none(`DELETE FROM four_conversations WHERE user_id = $1`, [userId]);
    await t.none(`DELETE FROM four_active_intents WHERE user_id = $1`, [userId]);
    await t.none(`DELETE FROM four_sessions WHERE user_id = $1`, [userId]);
    await t.none(
      `DELETE FROM four_whatsapp_links WHERE whatsapp_phone_e164 = $1`,
      [phoneE164]
    );

    await t.none(
      `UPDATE users
          SET transaction_pin = NULL,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId]
    );

    await t.none(`DELETE FROM wallet_transactions WHERE user_id = $1`, [
      userId,
    ]);
    await t.none(`DELETE FROM wallets WHERE user_id = $1`, [userId]);
  });

  console.log('Done. Send "Hey" on WhatsApp to start onboarding again.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
