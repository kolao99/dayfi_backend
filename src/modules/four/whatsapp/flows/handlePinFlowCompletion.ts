import { setupTransactionPin } from '../../security/pinSetupService';
import { FourError } from '../../errors';
import { verifyWhatsappFlowToken } from './flowToken';
import {
  createConversation,
  getLatestConversation,
} from '../../conversation/conversationService';
import { deliverWhatsappReplies } from '../whatsappDelivery';
import { updateLinkMetadata } from '../whatsappLinkService';
import { appendMessage } from '../../conversation/messageService';

/**
 * Handle WhatsApp Flow nfm_reply for PIN setup.
 * PIN digits never go to LLM / are never stored in chat as plaintext.
 */
export async function handleWhatsappPinFlowCompletion(input: {
  phoneE164: string;
  userId: string;
  flowToken: string;
  response: Record<string, unknown>;
}): Promise<boolean> {
  const verified = verifyWhatsappFlowToken(input.flowToken);
  if (!verified.ok) {
    console.warn('[azap/flow] invalid flow token', verified.reason);
    return false;
  }
  if (verified.purpose !== 'pin_setup') {
    return false;
  }
  if (verified.userId !== input.userId) {
    console.warn('[azap/flow] flow token user mismatch');
    return false;
  }

  const pin = String(
    input.response.pin ?? input.response.PIN ?? ''
  ).replace(/\D/g, '');
  const confirmPin = String(
    input.response.confirm_pin ??
      input.response.confirmPin ??
      input.response.pin_confirm ??
      ''
  ).replace(/\D/g, '');

  let conversation = await getLatestConversation(input.userId);
  if (!conversation) {
    conversation = await createConversation(input.userId, 'WhatsApp');
  }

  await appendMessage({
    userId: input.userId,
    conversationId: conversation.id,
    role: 'user',
    type: 'text',
    content: 'Completed PIN setup in WhatsApp',
    metadata: {
      source: 'whatsapp_flow',
      flow: 'pin_setup',
      channel: 'whatsapp',
    },
  });

  try {
    await setupTransactionPin({
      userId: input.userId,
      pin,
      confirmPin: confirmPin || pin,
    });
    await updateLinkMetadata(input.phoneE164, {
      pinSetupStep: null,
      pinSetupDraft: null,
      introShown: true,
    });
    return true;
  } catch (err) {
    const message =
      err instanceof FourError
        ? err.message
        : 'Could not save your PIN. Please try again.';
    await deliverWhatsappReplies(
      input.phoneE164,
      input.userId,
      conversation.id,
      [
        {
          role: 'assistant',
          type: 'text',
          content: `${message}\n\nTap "Set up your PIN" again to retry in WhatsApp.`,
        },
      ]
    );
    return true;
  }
}
