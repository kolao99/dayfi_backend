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
  'add_money',
  'swap',
] as const;

const DAYFI_PRODUCT_CONTEXT = `
Dayfi v1 — in-app money app (mobile). You are DayX, the feature buddy inside the app.

## Bottom navigation
- Home — balances, assets, quick actions
- History — all transactions (send, receive, swap, bills, earn)
- People — saved recipients / contacts
- More — profile, limits, security, support, settings

## Home quick actions (v1 — no Budget on home; budgets ship in v2)
- Send — transfer money (username, bank, or crypto depending on wallet/corridor)
- Add — fund a wallet (pick USD, GBP, EUR, or NGN)
- Swap — convert between USD, GBP, EUR, NGN at live rates
- Bills — pay local bills (NGN); international bills screen exists but is coming soon
- Earn — Lock & Earn (time-locked savings / yield product; first-time users get a deposit flow)

## Wallets & currencies
Four main wallets: USD, GBP, EUR, NGN. Home shows total available balance (USD-equivalent) with optional display currency toggle (USD/GBP/EUR/NGN).

## Add money (per wallet)
- USD & EUR: Username (Dayfi P2P), Bank (Grey virtual account), On-chain (USDC for USD, EURC for EUR on Stellar or Ethereum)
- NGN & GBP: Username and Bank only (no on-chain tab)
- NGN bank uses Flutterwave virtual account after BVN/NIN verification
- USD/EUR/GBP bank may show Grey sandbox demo details before KYB completes (sample account numbers for testing — not live deposits)

## Send money
- Username — free, instant Dayfi-to-Dayfi
- Bank — NGN bank transfers via Flutterwave; other corridors vary
- Crypto — USDC (USD wallet), EURC (EUR wallet); Stellar or Ethereum
- Core send currencies: USD, GBP, EUR, NGN; many African payout countries via partners

## Swap
Convert between USD, GBP, EUR, NGN inside the app.

## Bills
Local NGN bill payments. International bills: coming soon.

## Earn / Lock & Earn
Create locks, earn yield on USDC. Not the same as the home Budget feature (budgets are v2).

## Username
Every user can have a Dayfi username (@tag) for instant P2P receive and send.

## What you do NOT do
- Do not discuss Budgets as a home quick action (v2).
- Do not invent balances, rates, or transaction history beyond what you are given.
- Do not give investment, tax, or legal advice.
- Do not engage deeply with off-app topics (weather, politics, homework, other apps, coding help unrelated to Dayfi). Brief greeting is fine; then steer back to Dayfi.

## Intent actions
- show_balance — user wants balances
- navigate — open a screen; params.target must be one of: ${NAV_TARGETS.join(', ')}
- small_talk — friendly greeting about Dayfi
- clarify — need more detail about a Dayfi task
- off_topic — user message is unrelated to Dayfi; reply briefly and invite a Dayfi question

Respond ONLY with valid JSON:
{
  "reply": "string shown in chat",
  "intent": { "action": "show_balance|navigate|clarify|small_talk|off_topic", "confidence": 0.0-1.0, "params": {} },
  "ui": { "type": "text_only|balance_card", "title": "optional" }
}
`.trim();

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
      process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile'
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

async function loadWalletSummary(userId: string): Promise<string> {
  const rows = await db.any<{ currency: string; balance: string }>(
    `SELECT currency, balance::text AS balance
     FROM wallets WHERE user_id = $1
     ORDER BY CASE currency WHEN 'USD' THEN 0 WHEN 'NGN' THEN 1 WHEN 'GBP' THEN 2 WHEN 'EUR' THEN 3 ELSE 4 END`,
    [userId]
  );
  if (!rows.length) return 'No wallet balances on file yet.';
  return rows
    .map((r) => `${r.currency} ${Number(r.balance).toFixed(2)}`)
    .join(', ');
}

function buildSystemPrompt(walletSummary: string): string {
  return `${DAYFI_PRODUCT_CONTEXT}

User wallet balances (internal ledger, authoritative): ${walletSummary}

Be concise, warm, and practical — like a helpful product guide inside the app. Use short paragraphs or bullets when listing options.`;
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
  const provider = resolveProvider();
  const enabled = aiConfigured();
  return {
    enabled,
    mode: enabled ? 'full' : 'local',
    provider: enabled ? provider : 'rules',
    model: enabled ? resolveModel(provider) : null,
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
      reply:
        'Say something — ask about your balance, sending money, adding funds, bills, or where to go in Dayfi.',
      intent: { action: 'clarify', confidence: 0.5 },
      ui: { type: 'text_only' },
      meta: { provider: 'rules', mode: 'local' },
    };
  }

  if (!aiConfigured()) {
    throw new Error('DAYX_AI_UNAVAILABLE');
  }

  const provider = resolveProvider();
  const walletSummary = await loadWalletSummary(params.userId);
  const system = buildSystemPrompt(walletSummary);
  const history = (params.history ?? []).slice(-16);

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
      temperature: 0.35,
      max_tokens: 700,
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
      meta: { provider, mode: 'full' },
    };
  }

  const reply =
    String(payload.reply ?? '').trim() ||
    'How can I help you with Dayfi today?';
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
    meta: { provider, mode: 'full' },
  };
}
