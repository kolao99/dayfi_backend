import axios from 'axios';
import { db } from '../../config/database';

export type DayxHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type DayxChatResult = {
  reply: string;
  intent?: {
    action: string;
    confidence: number;
    params?: Record<string, unknown>;
  };
  ui?: {
    type: string;
    title?: string;
  };
  meta: {
    provider: string;
    mode: 'full' | 'local';
  };
};

const NAV_TARGETS = [
  'home',
  'transactions',
  'recipients',
  'profile',
  'invest',
  'pay',
  'send',
  'budgets',
  'add_money',
  'swap',
] as const;

function openAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

async function loadWalletSummary(userId: string): Promise<string> {
  const rows = await db.any<{ currency: string; balance: string }>(
    `SELECT currency, balance::text AS balance
     FROM wallets WHERE user_id = $1
     ORDER BY CASE currency WHEN 'USD' THEN 0 WHEN 'NGN' THEN 1 ELSE 2 END`,
    [userId]
  );
  if (!rows.length) return 'No wallet balances on file yet.';
  return rows
    .map((r) => `${r.currency} ${Number(r.balance).toFixed(2)}`)
    .join(', ');
}

function buildSystemPrompt(walletSummary: string): string {
  return `You are DayX, the in-app AI assistant for Dayfi (a money app: send, receive, swap, Lock & Earn, bills, budgets).

User wallet balances (internal ledger): ${walletSummary}

You help users understand their money and navigate the app. Be concise, friendly, and practical.

When the user asks to see balances, set intent action "show_balance".
When they want to open a screen, set intent action "navigate" with params.target as one of: ${NAV_TARGETS.join(', ')}.
For general conversation, use action "small_talk" or "clarify".

Respond ONLY with valid JSON:
{
  "reply": "string shown in chat",
  "intent": { "action": "show_balance|navigate|clarify|small_talk", "confidence": 0.0-1.0, "params": {} },
  "ui": { "type": "text_only|balance_card", "title": "optional" }
}

Do not invent balances beyond the summary. Do not give investment advice.`;
}

function parseModelJson(raw: string): DayxChatResult['intent'] | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const intent = parsed.intent as Record<string, unknown> | undefined;
    if (!intent?.action) return undefined;
    return {
      action: String(intent.action),
      confidence: Number(intent.confidence ?? 0.8),
      params: (intent.params as Record<string, unknown>) ?? {},
    };
  } catch {
    return undefined;
  }
}

export function getDayxStatus() {
  const enabled = openAiConfigured();
  return {
    enabled,
    mode: enabled ? 'full' : 'local',
    provider: enabled ? 'openai' : 'rules',
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
  };
}

export async function chatWithDayx(params: {
  userId: string;
  message: string;
  history?: DayxHistoryMessage[];
}): Promise<DayxChatResult> {
  const message = params.message.trim();
  if (!message) {
    return {
      reply: 'Say something — ask about your balance or where to go in Dayfi.',
      intent: { action: 'clarify', confidence: 0.5 },
      ui: { type: 'text_only' },
      meta: { provider: 'rules', mode: 'local' },
    };
  }

  if (!openAiConfigured()) {
    throw new Error('DAYX_AI_UNAVAILABLE');
  }

  const walletSummary = await loadWalletSummary(params.userId);
  const system = buildSystemPrompt(walletSummary);
  const history = (params.history ?? []).slice(-16);

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const apiKey = process.env.OPENAI_API_KEY!.trim();

  const { data } = await axios.post<{
    choices?: { message?: { content?: string } }[];
  }>(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      temperature: 0.4,
      max_tokens: 600,
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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {
      reply: content,
      meta: { provider: 'openai', mode: 'full' },
    };
  }

  const reply = String(payload.reply ?? '').trim() || 'How can I help you with Dayfi?';
  const intent = parseModelJson(content);
  const ui = payload.ui as Record<string, unknown> | undefined;

  return {
    reply,
    intent,
    ui: ui
      ? {
          type: String(ui.type ?? 'text_only'),
          title: ui.title ? String(ui.title) : undefined,
        }
      : intent?.action === 'show_balance'
        ? { type: 'balance_card', title: 'Your balances' }
        : { type: 'text_only' },
    meta: { provider: 'openai', mode: 'full' },
  };
}
