import axios from 'axios';
import type {
  LLMProvider,
  LlmChatMessage,
  LlmPlanRequest,
  LlmPlanResult,
} from './provider';
import { StubLLMProvider } from './stubProvider';
import { AZAP_MAX_ACTIONS } from '../actionPlan/types';
import {
  getSupportedCryptoAssets,
  getSupportedCryptoNetworks,
} from '../capabilities/moneyCapabilities';

function groqKey(): string {
  return (
    process.env.AZAP_GROQ_API_KEY?.trim() ||
    process.env.GROQ_API_KEY?.trim() ||
    ''
  );
}

function groqModel(): string {
  return (
    process.env.AZAP_GROQ_MODEL?.trim() ||
    process.env.GROQ_MODEL?.trim() ||
    'llama-3.3-70b-versatile'
  );
}

function mapActions(raw: unknown): LlmPlanResult['plan']['actions'] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, AZAP_MAX_ACTIONS).map((item, i) => {
    const a = (item ?? {}) as Record<string, unknown>;
    const type = String(a.type || a.action || 'balance_check');
    return {
      id: `action_${i + 1}`,
      type: type as LlmPlanResult['plan']['actions'][number]['type'],
      status: 'needs_resolution',
      amount: a.amount != null ? String(a.amount) : null,
      currency: a.currency != null ? String(a.currency) : null,
      recipientReference:
        a.recipientReference != null ? String(a.recipientReference) : null,
      asset: a.asset != null ? String(a.asset) : null,
      network: a.network != null ? String(a.network) : null,
      slots:
        typeof a.slots === 'object' && a.slots
          ? (a.slots as Record<string, unknown>)
          : {},
    };
  });
}

/**
 * Groq JSON planner. Never executes money. Falls back to stub on any failure.
 */
export class GroqLLMProvider implements LLMProvider {
  readonly name = 'groq';
  private fallback = new StubLLMProvider();

  async planActions(input: LlmPlanRequest): Promise<LlmPlanResult> {
    const key = groqKey();
    if (!key) {
      return this.fallback.planActions(input);
    }

    const started = Date.now();
    try {
      const usdcNets = getSupportedCryptoNetworks('USDC', 'receive')
        .map((n) => n.name)
        .join(', ');
      const eurcNets = getSupportedCryptoNetworks('EURC', 'receive')
        .map((n) => n.name)
        .join(', ');
      const assets = getSupportedCryptoAssets().join(', ');

      const system =
        `You extract financial intents for Azap by Dayfi. Return JSON only.\n` +
        `Schema: {"actions":[{"type":"bank_transfer|crypto_deposit|crypto_transfer|fiat_funding|balance_check|airtime_purchase|bill_payment|kyc","amount":string|null,"currency":string|null,"recipientReference":string|null,"asset":string|null,"network":string|null}]}\n` +
        `Max ${AZAP_MAX_ACTIONS} actions. Do not invent balances, fees, addresses, or KYC.\n` +
        `Supported crypto assets: ${assets}. USDC networks: ${usdcNets}. EURC networks: ${eurcNets}.\n` +
        `Use crypto_deposit for funding/receiving crypto. crypto_transfer for sending crypto out.\n` +
        `Use bank_transfer for NGN send. Never claim a transaction succeeded.`;

      const { data } = await axios.post<{
        choices?: { message?: { content?: string } }[];
      }>(
        process.env.GROQ_BASE_URL?.trim() ||
          'https://api.groq.com/openai/v1/chat/completions',
        {
          model: groqModel(),
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input.text },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('empty groq');
      const parsed = JSON.parse(content) as { actions?: unknown };
      const actions = mapActions(parsed.actions);
      if (!actions.length) {
        return this.fallback.planActions(input);
      }

      console.info(
        JSON.stringify({
          event: 'azap_llm_plan',
          provider: 'groq',
          model: groqModel(),
          conversationId: input.conversationId,
          actionCount: actions.length,
          latencyMs: Date.now() - started,
        })
      );

      const requiresPin = actions.some((a) =>
        [
          'bank_transfer',
          'crypto_transfer',
          'airtime_purchase',
          'bill_payment',
        ].includes(a.type)
      );

      return {
        plan: {
          actions,
          requiresResolution: true,
          requiresConfirmation: requiresPin,
          requiresPin,
        },
      };
    } catch (err) {
      console.warn(
        '[azap/llm] groq plan failed, using stub',
        err instanceof Error ? err.message : 'error'
      );
      return this.fallback.planActions(input);
    }
  }

  async complete(messages: LlmChatMessage[]): Promise<string> {
    const key = groqKey();
    if (!key) {
      return this.fallback.complete ? this.fallback.complete(messages) : '';
    }
    try {
      const { data } = await axios.post<{
        choices?: { message?: { content?: string } }[];
      }>(
        process.env.GROQ_BASE_URL?.trim() ||
          'https://api.groq.com/openai/v1/chat/completions',
        {
          model: groqModel(),
          temperature: 0.3,
          max_tokens: 220,
          messages,
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );
      return String(data.choices?.[0]?.message?.content || '').trim();
    } catch {
      return '';
    }
  }
}
