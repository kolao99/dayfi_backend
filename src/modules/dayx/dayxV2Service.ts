import axios from 'axios';
import { db } from '../../config/database';
import {
  buildTotalNgnBalanceReply,
  detectTotalInNairaQuery,
} from './dayxBalanceReply';
import { buildConversationSummary } from './dayxConversationSummary';
import type { DayxChatResult, DayxHistoryMessage } from './dayxService';
import {
  loadBeneficiarySummary,
  loadRecentPayeesSummary,
  loadWalletSummary,
  parseModelPayload,
} from './dayxService';
import { buildDayxV2SystemPrompt } from './dayxV2Prompt';

function groqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

function openAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function aiConfigured(): boolean {
  return groqConfigured() || openAiConfigured();
}

function resolveProvider(): 'groq' | 'openai' {
  return groqConfigured() ? 'groq' : 'openai';
}

function resolveModel(provider: 'groq' | 'openai'): string {
  if (provider === 'groq') {
    return (
      process.env.GROQ_MODEL?.trim() ||
      'llama-3.3-70b-versatile'
    );
  }
  return process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
}

function resolveApiUrl(provider: 'groq' | 'openai'): string {
  if (provider === 'groq') {
    return (
      process.env.GROQ_BASE_URL?.trim() ||
      'https://api.groq.com/openai/v1/chat/completions'
    );
  }
  return 'https://api.openai.com/v1/chat/completions';
}

function resolveApiKey(provider: 'groq' | 'openai'): string {
  if (provider === 'groq') {
    return process.env.GROQ_API_KEY!.trim();
  }
  return process.env.OPENAI_API_KEY!.trim();
}

async function loadUserFirstName(userId: string): Promise<string | undefined> {
  const row = await db.oneOrNone<{ first_name: string | null }>(
    `SELECT first_name FROM users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const name = row?.first_name?.trim();
  return name && name.length > 0 ? name : undefined;
}

export type DayxV2ChatParams = {
  userId: string;
  message: string;
  history?: DayxHistoryMessage[];
  voiceName?: string;
  firstName?: string;
  isFirstSession?: boolean;
};

export async function chatWithDayxV2(
  params: DayxV2ChatParams
): Promise<DayxChatResult> {
  const message = params.message.trim();
  const voiceName = params.voiceName?.trim() || 'DayX';

  if (!message) {
    return {
      reply: `Welcome back! Wetin you wan do today?`,
      voiceReply: `Wetin you wan do today?`,
      suggestions: ['Send money', 'Pay bills', 'Check balance'],
      intent: { action: 'clarify', confidence: 0.5 },
      ui: { type: 'text_only' },
      meta: { provider: 'rules', mode: 'local' },
    };
  }

  if (!aiConfigured()) {
    throw new Error('DAYX_AI_UNAVAILABLE');
  }

  if (detectTotalInNairaQuery(message)) {
    const reply = await buildTotalNgnBalanceReply(params.userId);
    return {
      reply,
      voiceReply: reply.slice(0, 120),
      intent: { action: 'show_balance', confidence: 0.95 },
      ui: { type: 'balance_card', title: 'Total in NGN' },
      meta: { provider: 'rules', mode: 'full' },
    };
  }

  const provider = resolveProvider();

  const [walletSummary, beneficiaries, recentPayees, dbFirstName] =
    await Promise.all([
      loadWalletSummary(params.userId),
      loadBeneficiarySummary(params.userId),
      loadRecentPayeesSummary(params.userId),
      params.firstName ? Promise.resolve(params.firstName) : loadUserFirstName(params.userId),
    ]);

  const history = (params.history ?? []).slice(-16);
  const conversationSummary = buildConversationSummary(history);

  const system = buildDayxV2SystemPrompt({
    voiceName,
    firstName: dbFirstName,
    isFirstSession: params.isFirstSession === true,
    walletSummary,
    beneficiaries,
    recentPayees,
    conversationSummary,
  });

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const model = resolveModel(provider);
  const apiKey = resolveApiKey(provider);

  const { data } = await axios.post<{
    choices?: { message?: { content?: string } }[];
  }>(
    resolveApiUrl(provider),
    {
      model,
      temperature: 0.4,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Empty AI response');
  }

  const parsed = parseModelPayload(content);
  return {
    ...parsed,
    meta: { provider, mode: 'full' },
  };
}
