/**
 * Model-agnostic LLM provider. AzapCore must not depend on Groq specifics.
 */

import type { AzapActionPlan } from '../actionPlan/types';
import { StubLLMProvider } from './stubProvider';
import { GroqLLMProvider } from './groqProvider';

export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmPlanRequest = {
  userId: string;
  conversationId: string;
  text: string;
  savedRecipientAliases?: string[];
  savedBillerAliases?: string[];
};

export type LlmPlanResult = {
  plan: Omit<
    AzapActionPlan,
    'id' | 'createdAt' | 'updatedAt' | 'userId' | 'conversationId'
  > & {
    actions: AzapActionPlan['actions'];
  };
  assistantNote?: string;
};

export interface LLMProvider {
  readonly name: string;
  planActions(input: LlmPlanRequest): Promise<LlmPlanResult>;
  complete?(messages: LlmChatMessage[]): Promise<string>;
}

export function createLlmProviderFromEnv(): LLMProvider {
  const driver = String(process.env.AZAP_LLM_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (driver === 'stub') {
    return new StubLLMProvider();
  }
  if (driver === 'groq') {
    return new GroqLLMProvider();
  }
  // Production default: use Groq when a key is present. Tests should set AZAP_LLM_PROVIDER=stub.
  const key =
    process.env.AZAP_GROQ_API_KEY?.trim() ||
    process.env.GROQ_API_KEY?.trim() ||
    '';
  if (key) {
    return new GroqLLMProvider();
  }
  return new StubLLMProvider();
}
