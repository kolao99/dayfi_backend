import { db } from '../../../config/database';
import HashText from '../../../shared/services/hashing';
import { FourError } from '../errors';
import { getUserById } from '../auth/identityService';
import { getLinkByUserId } from '../telegram/telegramLinkService';
import { sendTelegramMessage } from '../telegram/telegramClient';
import { pinSecuredMessage } from '../telegram/onboardingService';
import { sendCapabilitiesIntro } from '../telegram/telegramRouter';

export async function setupTransactionPin(input: {
  userId: string;
  pin: string;
  confirmPin: string;
}): Promise<{ ok: true }> {
  if (input.pin !== input.confirmPin) {
    throw new FourError('pin_mismatch');
  }
  if (!/^\d{4}$/.test(input.pin)) {
    throw new FourError('pin_invalid');
  }

  const user = await getUserById(input.userId);
  if (!user) {
    throw new FourError('session_invalid');
  }
  if (user.transaction_pin) {
    throw new FourError('pin_already_set');
  }

  const hashed = await HashText.hash(input.pin);
  await db.none(
    `UPDATE users SET transaction_pin = $2, updated_at = NOW() WHERE user_id = $1`,
    [input.userId, hashed]
  );

  const link = await getLinkByUserId(input.userId);
  if (link?.chat_id) {
    await sendTelegramMessage({
      chatId: link.chat_id,
      text: '🚀 Securing your account 🔐...',
    });
    await sendTelegramMessage({
      chatId: link.chat_id,
      text: pinSecuredMessage(),
    });
    await sendCapabilitiesIntro(
      link.chat_id,
      input.userId,
      link.telegram_user_id
    );
  }

  return { ok: true };
}
