import axios from 'axios';
import { db } from '../../config/database';

export type DayxHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type DayxTransferCandidate = {
  beneficiaryId: string;
  name: string;
  accountMask?: string;
  country?: string;
};

export type DayxTransferProposal = {
  status: 'needs_confirmation' | 'ambiguous' | 'not_found' | 'info_only';
  amount?: number;
  currency?: string;
  recipientName?: string;
  beneficiaryId?: string;
  accountMask?: string;
  candidates?: DayxTransferCandidate[];
};

export type DayxSpendingInsight = {
  title: string;
  message: string;
  metric?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'info';
};

export type DayxChatResult = {
  reply: string;
  voiceReply?: string;
  startFlow?: 'send' | 'add_money' | 'swap' | 'pay' | null;
  flowSlots?: Record<string, unknown>;
  suggestions?: string[];
  spendingInsights?: DayxSpendingInsight[];
  transferProposal?: DayxTransferProposal;
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
  'dayflow',
  'pay',
  'send',
  'add_money',
  'swap',
  'support',
  'withdraw',
] as const;

const DAYX_SYSTEM_PROMPT = `
You are DayX, the embedded financial AI inside Dayfi — a multi-currency wallet app (NGN, USD, EUR, GBP).
You are smart, warm, concise and trustworthy. You help users send money, top up wallets, swap currencies, and pay local bills — all inside this conversation.

## Personality
Calm, premium, human — like a phone call with a sharp money assistant. Max 40 words per reply. No bullet lists in reply text.

## RULES (mandatory)
1. Never ask users to open another screen. Everything happens in this chat/voice overlay.
2. The flow engine runs the steps. You understand natural language, extract slots, and give one short reply for the current moment.
3. NEVER invent balances, rates, account numbers, or recipients — only use Live context below.
4. Send money: start flow "send" only when the user clearly wants to send — NOT on greetings (hi, hello, hey).
5. Top up / add money: startFlow "add_money". Swap: "swap". Bills: "pay".
6. Greetings and small talk (hi, hello, thanks, cool): use small_talk intent only — startFlow MUST be null.
7. International bills: say coming soon, offer local bills instead.
8. Insufficient balance: suggest topping up the same wallet in-conversation.
9. FORBIDDEN: "I cannot perform transactions", "Yellow Card", "whitelist", "open the Send screen", "navigate to".
10. Do NOT use navigate intent for send, swap, pay, add_money, withdraw — use startFlow instead.
11. voiceReply: max 20 words, spoken tone.

## DayFi product (v1)
### Bottom nav
- Home — balances, assets, quick actions (Send, Add, Swap, Bills, Earn)
- History — all transactions
- People — saved recipients
- More — profile, limits, security, support

### Wallets
USD, GBP, EUR, NGN. Balances in context are authoritative.

### Features
- Send — username, bank, crypto by corridor
- Add money — fund wallets
- Swap — convert between USD, GBP, EUR, NGN
- Bills — NGN local bills (Pay bills)
- DayEarn — savings pots with daily interest (replaces Lock & Earn)
- DayFlow — AI budgeting assistant (navigate target dayflow)

## Intent actions
- show_balance — show wallet balances (ui: balance_card)
- navigate — open screen; params.target one of: ${NAV_TARGETS.join(', ')}
  - send = send money flow
  - pay = bills
  - invest / earn = DayEarn
  - dayflow = DayFlow budget assistant
  - swap = currency swap
  - add_money = fund wallet
  - transactions = history
  - recipients = saved people
  - profile = settings/more
  - support = customer support (Intercom)
  - withdraw = withdraw funds (route to send/add as appropriate)
- open_support — same as navigate support
- propose_transfer — user wants to send money to someone; MUST include transferProposal
- spending_insight — brief insight from recent activity (ui: spending_insight)
- clarify — need more info
- small_talk — brief friendly greeting, steer to DayFi
- off_topic — unrelated; brief redirect

## transferProposal rules
When user says e.g. "Send 10,000 naira to Amaka":
1. Search Saved beneficiaries and Recent payees in context
2. If one clear match: status "needs_confirmation", fill amount/currency/recipientName/beneficiaryId/accountMask (last 4 digits)
3. If multiple: status "ambiguous", candidates array (max 4)
4. If none: status "not_found"
5. Reply asks for confirmation — never say money was sent

## spendingInsights rules
When user asks about spending, patterns, or "where did my money go":
- Use intent action spending_insight and ui.type spending_insight
- Derive insights ONLY from Recent activity and Wallet balances in context — never invent numbers
- Return 1-3 cards in spendingInsights array:
  { "title": "Short label", "message": "One clear sentence", "metric": "optional e.g. NGN 45,000", "tone": "neutral|positive|warning|info" }
- Omit transferProposal for pure insight responses

## Response format — JSON ONLY
{
  "reply": "text shown in chat",
  "voiceReply": "short spoken version",
  "startFlow": "send|add_money|swap|pay|null",
  "slots": {
    "spendCurrency": "NGN|USD|EUR|GBP|null",
    "receiveCountry": "NG|US|GB|null",
    "amount": null,
    "recipientHint": "string|null"
  },
  "suggestions": ["Check balance", "Send money"],
  "spendingInsights": [
    { "title": "Top spend", "message": "Most of your recent outflows went to transfers.", "metric": "NGN 120,000", "tone": "info" }
  ],
  "transferProposal": {
    "status": "needs_confirmation",
    "amount": 10000,
    "currency": "NGN",
    "recipientName": "Amaka Okafor",
    "beneficiaryId": "uuid-if-known",
    "accountMask": "2231",
    "candidates": [{ "beneficiaryId": "...", "name": "...", "accountMask": "2231" }]
  },
  "intent": { "action": "...", "confidence": 0.0-1.0, "params": {} },
  "ui": { "type": "text_only|balance_card|transfer_confirm|spending_insight", "title": "optional" }
}

Omit transferProposal when not proposing a transfer. Include 3-5 helpful suggestions when appropriate.
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

function maskAccount(accountNumber?: string | null): string | undefined {
  if (!accountNumber || accountNumber.length < 4) return undefined;
  return accountNumber.slice(-4);
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

async function loadBeneficiarySummary(userId: string): Promise<string> {
  const rows = await db.any<{
    id: string;
    name: string;
    country: string | null;
    account_number: string | null;
  }>(
    `SELECT b.id, b.name, b.country, s.account_number
     FROM beneficiaries b
     LEFT JOIN LATERAL (
       SELECT account_number FROM source WHERE beneficiary_id = b.id LIMIT 1
     ) s ON true
     WHERE b.user_id = $1
     ORDER BY b.name ASC
     LIMIT 25`,
    [userId]
  );
  if (!rows.length) return 'No saved beneficiaries yet.';
  return rows
    .map((r) => {
      const mask = maskAccount(r.account_number);
      const acct = mask ? ` (…${mask})` : '';
      return `${r.name}${acct} [id:${r.id}]`;
    })
    .join('; ');
}

async function loadRecentPayeesSummary(userId: string): Promise<string> {
  const rows = await db.any<{
    name: string | null;
    amount: string;
    currency: string | null;
    activity_kind: string | null;
    ts: Date;
  }>(
    `SELECT b.name, wt.send_amount::text AS amount, wt.ledger_currency AS currency,
            wt.activity_kind, wt.timestamp AS ts
     FROM wallet_transactions wt
     LEFT JOIN beneficiaries b ON wt.beneficiary_id = b.id
     WHERE wt.user_id = $1
     ORDER BY wt.timestamp DESC
     LIMIT 12`,
    [userId]
  );
  if (!rows.length) return 'No recent transactions yet.';
  return rows
    .map((r) => {
      const who = r.name ?? 'Unknown';
      const amt = Number(r.amount).toFixed(0);
      const cur = r.currency ?? 'NGN';
      const kind = r.activity_kind ?? 'transfer';
      return `${who}: ${cur} ${amt} (${kind})`;
    })
    .join('; ');
}

function buildSystemPrompt(ctx: {
  walletSummary: string;
  beneficiaries: string;
  recentPayees: string;
}): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  return `${DAYX_SYSTEM_PROMPT}

## Live context (${dateStr}) — authoritative, do not invent beyond this
Wallet balances: ${ctx.walletSummary}
Saved beneficiaries: ${ctx.beneficiaries}
Recent activity: ${ctx.recentPayees}`;
}

function parseTransferProposal(raw: unknown): DayxTransferProposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const status = String(p.status ?? 'info_only') as DayxTransferProposal['status'];
  const candidatesRaw = p.candidates;
  const candidates = Array.isArray(candidatesRaw)
    ? candidatesRaw
        .filter((c) => c && typeof c === 'object')
        .slice(0, 4)
        .map((c) => {
          const row = c as Record<string, unknown>;
          return {
            beneficiaryId: String(row.beneficiaryId ?? row.beneficiary_id ?? ''),
            name: String(row.name ?? ''),
            accountMask: row.accountMask
              ? String(row.accountMask)
              : row.account_mask
                ? String(row.account_mask)
                : undefined,
            country: row.country ? String(row.country) : undefined,
          };
        })
        .filter((c) => c.beneficiaryId || c.name)
    : undefined;

  return {
    status,
    amount: p.amount != null ? Number(p.amount) : undefined,
    currency: p.currency ? String(p.currency) : undefined,
    recipientName: p.recipientName
      ? String(p.recipientName)
      : p.recipient_name
        ? String(p.recipient_name)
        : undefined,
    beneficiaryId: p.beneficiaryId
      ? String(p.beneficiaryId)
      : p.beneficiary_id
        ? String(p.beneficiary_id)
        : undefined,
    accountMask: p.accountMask
      ? String(p.accountMask)
      : p.account_mask
        ? String(p.account_mask)
        : undefined,
    candidates,
  };
}

function parseSpendingInsights(raw: unknown): DayxSpendingInsight[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const insights: DayxSpendingInsight[] = [];
  for (const item of raw.slice(0, 3)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title = String(row.title ?? '').trim();
    const message = String(row.message ?? '').trim();
    if (!title || !message) continue;
    const toneRaw = String(row.tone ?? 'neutral').toLowerCase();
    const tone: DayxSpendingInsight['tone'] =
      toneRaw === 'positive' ||
      toneRaw === 'warning' ||
      toneRaw === 'info' ||
      toneRaw === 'neutral'
        ? toneRaw
        : 'neutral';
    insights.push({
      title,
      message,
      metric: row.metric ? String(row.metric).trim() : undefined,
      tone,
    });
  }
  return insights.length ? insights : undefined;
}

function parseModelPayload(content: string): Omit<DayxChatResult, 'meta'> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { reply: content };
  }

  const reply =
    String(payload.reply ?? '').trim() ||
    'How can I help you with DayFi today?';
  const voiceReply = payload.voiceReply
    ? String(payload.voiceReply).trim()
    : undefined;

  const suggestionsRaw = payload.suggestions;
  const suggestions = Array.isArray(suggestionsRaw)
    ? suggestionsRaw.map((s) => String(s)).filter(Boolean).slice(0, 6)
    : undefined;

  const transferProposal = parseTransferProposal(payload.transferProposal);
  const spendingInsights = parseSpendingInsights(payload.spendingInsights);

  let intent: DayxChatResult['intent'];
  const intentRaw = payload.intent as Record<string, unknown> | undefined;
  if (intentRaw?.action) {
    intent = {
      action: String(intentRaw.action),
      confidence: Number(intentRaw.confidence ?? 0.8),
      params: (intentRaw.params as Record<string, unknown>) ?? {},
    };
  }

  const uiRaw = payload.ui as Record<string, unknown> | undefined;
  let ui: DayxChatResult['ui'];
  if (uiRaw) {
    ui = {
      type: String(uiRaw.type ?? 'text_only'),
      title: uiRaw.title ? String(uiRaw.title) : undefined,
    };
  } else if (intent?.action === 'show_balance') {
    ui = { type: 'balance_card', title: 'Your balances' };
  } else if (
    transferProposal?.status === 'needs_confirmation' ||
    transferProposal?.status === 'ambiguous'
  ) {
    ui = { type: 'transfer_confirm', title: 'Confirm transfer' };
  } else if (intent?.action === 'spending_insight' || spendingInsights?.length) {
    ui = {
      type: 'spending_insight',
      title: 'Spending insights',
    };
  } else {
    ui = { type: 'text_only' };
  }

  if (transferProposal && !intent) {
    intent = {
      action: 'propose_transfer',
      confidence: 0.9,
      params: {},
    };
  }

  let startFlow: DayxChatResult['startFlow'];
  const sf = payload.startFlow;
  if (sf === 'send' || sf === 'add_money' || sf === 'swap' || sf === 'pay') {
    startFlow = sf;
  }

  const flowSlots =
    payload.slots && typeof payload.slots === 'object'
      ? (payload.slots as Record<string, unknown>)
      : undefined;

  return {
    reply,
    voiceReply,
    startFlow,
    flowSlots,
    suggestions,
    spendingInsights,
    transferProposal,
    intent,
    ui,
  };
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
      reply: 'How can I assist you today?',
      voiceReply: "I'm listening. What would you like to do?",
      suggestions: [
        'Check balance',
        'Send money',
        'Pay bills',
        'Open DayEarn',
      ],
      intent: { action: 'clarify', confidence: 0.5 },
      ui: { type: 'text_only' },
      meta: { provider: 'rules', mode: 'local' },
    };
  }

  if (!aiConfigured()) {
    throw new Error('DAYX_AI_UNAVAILABLE');
  }

  const provider = resolveProvider();
  const [walletSummary, beneficiaries, recentPayees] = await Promise.all([
    loadWalletSummary(params.userId),
    loadBeneficiarySummary(params.userId),
    loadRecentPayeesSummary(params.userId),
  ]);

  const system = buildSystemPrompt({
    walletSummary,
    beneficiaries,
    recentPayees,
  });
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
