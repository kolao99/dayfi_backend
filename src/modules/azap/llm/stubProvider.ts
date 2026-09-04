import type {
  LLMProvider,
  LlmChatMessage,
  LlmPlanRequest,
  LlmPlanResult,
} from './provider';
import { parseUserMessage } from '../../four/engine/intentParser';

/**
 * Deterministic stub: maps existing regex intent parser → ActionPlan shape.
 * Used until Groq (or another model) is wired. Never moves money.
 */
export class StubLLMProvider implements LLMProvider {
  readonly name = 'stub';

  async planActions(input: LlmPlanRequest): Promise<LlmPlanResult> {
    const parsed = parseUserMessage(input.text);
    const actions: LlmPlanResult['plan']['actions'] = [];

    if (parsed.kind === 'balance') {
      actions.push({
        id: 'action_1',
        type: 'balance_check',
        status: 'ready',
      });
    } else if (parsed.kind === 'kyc') {
      actions.push({
        id: 'action_1',
        type: 'kyc',
        status: 'ready',
      });
    } else if (parsed.kind === 'fund') {
      actions.push({
        id: 'action_1',
        type: 'fiat_funding',
        status: 'ready',
      });
    } else if (parsed.kind === 'send' || parsed.kind === 'send_prompt') {
      actions.push({
        id: 'action_1',
        type: 'bank_transfer',
        status: 'needs_resolution',
        amount:
          parsed.kind === 'send' && parsed.amount != null
            ? String(parsed.amount)
            : null,
        currency: 'NGN',
        recipientReference:
          parsed.kind === 'send' ? parsed.recipientName : null,
        slots:
          parsed.kind === 'send' && parsed.bankTarget
            ? { bankTarget: parsed.bankTarget }
            : {},
      });
    }

    const requiresPin = actions.some((a) =>
      [
        'bank_transfer',
        'airtime_purchase',
        'bill_payment',
        'crypto_transfer',
      ].includes(a.type)
    );

    return {
      plan: {
        actions,
        requiresResolution: actions.some(
          (a) => a.status === 'needs_resolution'
        ),
        requiresConfirmation: requiresPin,
        requiresPin,
      },
    };
  }

  async complete(messages: LlmChatMessage[]): Promise<string> {
    void messages;
    return '';
  }
}
