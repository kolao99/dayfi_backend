import { appendMessage } from '../conversation/messageService';
import type { EngineReply } from '../engine/conversationEngine';
import type { ChoiceButton } from '../telegram/onboardingService';
import { appendButtonHints, sendWhatsappMessage } from './whatsappClient';

export type RoutedReply = EngineReply & {
  buttons?: ChoiceButton[];
  scope?: string;
  secureUrl?: string | null;
  secureLabel?: string;
};

export async function deliverWhatsappReplies(
  phoneE164: string,
  userId: string,
  conversationId: string,
  replies: RoutedReply[]
): Promise<void> {
  for (const reply of replies) {
    const buttons = reply.buttons ?? [];
    let text = reply.content;
    const secureUrl = String(reply.secureUrl || '').trim() || null;
    const secureLabel = String(reply.secureLabel || '').trim() || undefined;

    // Prefer native CTA URL button; only append raw link as fallback.
    const activeButtons = buttons.filter((b) => !b.disabled);
    const useNativeButtons =
      !secureUrl &&
      activeButtons.length > 0 &&
      activeButtons.length <= 3;

    if (!secureUrl && !useNativeButtons) {
      text = appendButtonHints(text, buttons);
    } else if (secureUrl && !secureLabel) {
      text += `\n\n${secureUrl}`;
    }

    const sent = await sendWhatsappMessage({
      toPhoneE164: phoneE164,
      text,
      buttons: useNativeButtons ? activeButtons : undefined,
      ctaUrl: secureUrl,
      ctaLabel: secureLabel,
    });

    await appendMessage({
      userId,
      conversationId,
      role: 'assistant',
      type: reply.type,
      content: reply.content,
      metadata: {
        ...(reply.metadata ?? {}),
        buttons,
        scope: reply.scope,
        secureUrl,
        whatsappMessageSid: sent.messageSid,
        channel: 'whatsapp',
      },
    });
  }
}
