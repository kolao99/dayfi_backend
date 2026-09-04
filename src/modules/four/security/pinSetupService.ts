import { db } from '../../../config/database';
import HashText from '../../../shared/services/hashing';
import { FourError } from '../errors';
import { getUserById } from '../auth/identityService';
import { getLinkByUserId as getTelegramLinkByUserId } from '../telegram/telegramLinkService';
import { sendTelegramMessage } from '../telegram/telegramClient';
import {
  CAPABILITY_BUTTONS,
  capabilitiesIntro,
  pinSecuredMessage,
} from '../telegram/onboardingService';
import { sendCapabilitiesIntro as sendTelegramCapabilitiesIntro } from '../telegram/telegramRouter';
import {
  getLinkByUserId as getWhatsappLinkByUserId,
  updateLinkMetadata,
} from '../whatsapp/whatsappLinkService';
import { sendWhatsappMessage } from '../whatsapp/whatsappClient';
import {
  createConversation,
  getLatestConversation,
} from '../conversation/conversationService';
import { deliverWhatsappReplies } from '../whatsapp/whatsappDelivery';

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

  const telegramLink = await getTelegramLinkByUserId(input.userId);
  if (telegramLink?.chat_id) {
    await sendTelegramMessage({
      chatId: telegramLink.chat_id,
      text: '🚀 Securing your account 🔐...',
    });
    await sendTelegramMessage({
      chatId: telegramLink.chat_id,
      text: pinSecuredMessage(),
    });
    await sendTelegramCapabilitiesIntro(
      telegramLink.chat_id,
      input.userId,
      telegramLink.telegram_user_id
    );
  }

  const whatsappLink = await getWhatsappLinkByUserId(input.userId);
  if (whatsappLink?.whatsapp_phone_e164) {
    const phone = whatsappLink.whatsapp_phone_e164;
    await updateLinkMetadata(phone, {
      pinSetupStep: null,
      pinSetupDraft: null,
      introShown: true,
    });
    await sendWhatsappMessage({
      toPhoneE164: phone,
      text: pinSecuredMessage(),
    });

    let conversation = await getLatestConversation(input.userId);
    if (!conversation) {
      conversation = await createConversation(input.userId, 'WhatsApp');
    }
    await deliverWhatsappReplies(phone, input.userId, conversation.id, [
      {
        role: 'assistant',
        type: 'choice',
        content: capabilitiesIntro(),
        buttons: CAPABILITY_BUTTONS.map((b) => ({ ...b })),
        scope: 'capability',
      },
    ]);
  }

  return { ok: true };
}
