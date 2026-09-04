import { buildKycProfileSnapshot } from '../../kyc/smileService';
import { appendMessage } from '../conversation/messageService';
import type { EngineReply, EngineResult } from '../engine/conversationEngine';

async function persistAssistant(
  userId: string,
  conversationId: string,
  reply: EngineReply
): Promise<void> {
  await appendMessage({
    userId,
    conversationId,
    role: 'assistant',
    type: reply.type,
    content: reply.content,
    metadata: reply.metadata ?? {},
  });
}

/** Orchestrate existing Dayfi KYC — Four never duplicates verification logic. */
export async function handleKycRequest(input: {
  userId: string;
  conversationId: string;
  /** Why KYC is being requested — keeps copy accurate for teens. */
  reason?: 'send' | 'fund' | 'generic';
}): Promise<EngineResult> {
  const snapshot = await buildKycProfileSnapshot(input.userId);
  const reason = input.reason || 'generic';

  if (snapshot.nextVerificationStep === 'none' && snapshot.bvnVerified) {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content:
        reason === 'send'
          ? "You're verified — you can send money. Try again, e.g. Send ₦5,000 to Kola."
          : "You're all verified! Your identity is confirmed and you can fund your wallet with bank transfer and use other Dayfi features.",
    };
    await persistAssistant(input.userId, input.conversationId, reply);
    return { replies: [reply] };
  }

  if (snapshot.nextVerificationStep === 'tier3') {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content:
        'Your BVN is verified. To unlock the next tier, complete NIN verification in the Dayfi app when you are ready.',
    };
    await persistAssistant(input.userId, input.conversationId, reply);
    return { replies: [reply] };
  }

  const why =
    reason === 'send'
      ? 'send money'
      : reason === 'fund'
        ? 'fund your wallet with bank transfer'
        : 'use Dayfi money features';

  const reply: EngineReply = {
    role: 'assistant',
    type: 'choice',
    content:
      `Let's verify your identity so you can ${why}. Tap below to complete verification securely — your BVN stays private and is never shown in chat.`,
    metadata: {
      secureSurface: 'kyc',
      scope: 'kyc',
    },
  };
  await persistAssistant(input.userId, input.conversationId, reply);
  return { replies: [reply] };
}
