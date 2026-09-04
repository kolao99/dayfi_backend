import { getLatestConversation } from '../conversation/conversationService';
import { appendMessage } from '../conversation/messageService';
import { getLinkByUserId as getTelegramLink } from '../telegram/telegramLinkService';
import { sendTelegramMessage } from '../telegram/telegramClient';
import { getLinkByUserId as getWhatsappLink } from '../whatsapp/whatsappLinkService';
import { sendWhatsappMessage } from '../whatsapp/whatsappClient';

/**
 * Push an authoritative Dayfi result to Azap channels.
 * Templates only — never LLM-generated balances or statuses.
 */
export async function deliverAzapPush(
  userId: string,
  content: string,
  opts?: { persist?: boolean }
): Promise<void> {
  const text = String(content || '').trim();
  if (!text || !userId) return;

  try {
    if (opts?.persist !== false) {
      const conversation = await getLatestConversation(userId);
      if (conversation) {
        await appendMessage({
          userId,
          conversationId: conversation.id,
          role: 'assistant',
          type: 'receipt',
          content: text,
          metadata: { source: 'azap_notify' },
        });
      }
    }

    const wa = await getWhatsappLink(userId);
    if (wa?.whatsapp_phone_e164) {
      await sendWhatsappMessage({
        toPhoneE164: wa.whatsapp_phone_e164,
        text,
      });
    }

    const tg = await getTelegramLink(userId);
    if (tg?.chat_id) {
      const chatId = Number(tg.chat_id);
      if (Number.isFinite(chatId)) {
        await sendTelegramMessage({
          chatId,
          text,
        });
      }
    }
  } catch (err) {
    console.warn(
      '[azap/notify]',
      err instanceof Error ? err.message : 'deliver failed'
    );
  }
}
