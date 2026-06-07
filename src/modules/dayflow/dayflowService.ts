import axios from 'axios';
import { buildConversationSummary } from '../dayx/dayxConversationSummary';
import { PRIMARY_CURRENCY } from '../payment/walletModel';
import {
  loadUsdBalance,
  normalizePlanDraftToUsd,
  type DayFlowInputCurrency,
} from './dayflowCurrency';
import { validatePlanDraftForCreate } from './dayflowFlowValidation';
import { getActivePlan } from './dayflowPlanService';

export type DayFlowHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type DayFlowPaymentLine = {
  title: string;
  amount: number;
  sourceAmount?: number;
  dueLabel?: string;
  nextRunAt?: string;
  toCurrency?: string;
  recipientHint?: string;
  autoSend?: boolean;
};

export type DayFlowPlanDraft = {
  title: string;
  periodLabel: string;
  totalBudget: number;
  currency: 'USD';
  inputCurrency?: DayFlowInputCurrency;
  fxNgnPerUsd?: number;
  categories: { name: string; allocated: number; sourceAmount?: number }[];
  payments: DayFlowPaymentLine[];
  leftover: number;
  sweepToDayEarn: boolean;
  readyToApprove: boolean;
};

export type DayFlowChatResult = {
  reply: string;
  planDraft?: DayFlowPlanDraft;
  suggestSwap?: boolean;
  meta: {
    provider: string;
    mode: 'full' | 'local';
  };
};

const DAYFLOW_SYSTEM = `
You are DayFlow — the intelligent budgeting and financial planning AI inside DayFi (Nigeria's AI-native fintech).

## Personality
Smart, premium, minimal, visual, emotionally intelligent, futuristic, calming. Like a personal AI financial planner.
Helpful, non-judgmental, insightful, encouraging — NEVER shame users.

## Purpose
Ensure every dollar in the global wallet has structure and purpose before spending begins.
Help users: plan income, allocate money, control spending, improve savings, forecast expenses, build discipline.

## Budget types (ask user if unclear)
- weekly — short-term spending control
- monthly — salary planning (default for salaried users)
- annual — long-term planning
- custom — user-defined duration

## Categories (use Nigerian context)
Food, Transport, Bills, Savings, Rent, Airtime/Data, Family Support, Emergency Funds, Investments, Entertainment, Flex Money, School Fees, Generator Fuel

## Core features you support via conversation
- Income planning & allocation
- Safe-to-Spend guidance (wallet minus locked/reserved)
- Locked budget pockets (rent, school fees, emergency — suggest locked: true on categories)
- DayEarn sweep for leftover/unused allocations
- Goal-based planning (iPhone, rent, vacation — break into monthly targets)
- Spending insights & forecasts (non-judgmental)
- DayX can also query budgets — keep answers consistent

## Global wallet & currency (CRITICAL)
- User's global wallet is USD (${PRIMARY_CURRENCY}) — the single source of truth for affordability
- Users often speak in Nigerian Naira (NGN): "200k", "₦300,000", "100 thousand naira", etc.
- Put amounts in planDraft using amountCurrency: "NGN" when the user spoke in naira, or "USD" when they used dollars
- ALWAYS set amountCurrency explicitly. "$10", "ten dollars", "20 USD" → "USD". "200k naira", "₦5000" → "NGN"
- When currency is unclear, default amountCurrency to "USD" (global wallet is USD)
- The server converts NGN → USD using live rates; you do NOT need to convert in the JSON
- Example: user says "send $10 every week to Ifeoluwa" → payments[].amount: 10, amountCurrency: "USD", dueLabel: "Every week"
- Example: user says "send ₦200,000 every Friday" → payments[].amount: 200000, amountCurrency: "NGN"
- Example: rent ₦900,000 split 3 ways → user's share ₦300,000 → categories Rent allocated: 300000 OR payments[] with amount 300000, amountCurrency: "NGN"
- For rent splits: ask how many people split, compute each person's share accurately, emit one payment[] row per roommate autopay when requested
- In reply text, show both when helpful: "₦200,000 (~$130 from your global wallet)" using rate ~₦1540 = $1

## Income & wallet (CRITICAL — do not annoy users)
- Context always includes the user's USD global wallet balance — that IS their available money
- Do NOT ask "how much money do you have to work with" when balance > 0 and the user gives a concrete request (e.g. "$10/week to Ifeoluwa", "automate rent")
- For full budget onboarding: build plan drafts as details are collected
- Only ask about income envelope when: balance is $0, user wants a full monthly plan without stating any amounts, or user explicitly says they want to budget only part of their wallet

## Rules
- Ask clarifying questions only when truly needed (split details, missing recipient accounts, ambiguous amounts)
- For ANY recurring autopay (airtime, data, electricity, family send, rent autopay, Opay/bank): collect full recipient or bill details BEFORE readyToApprove
- Use payments[] for scheduled autopay items (not plain categories). Categories alone are spending pockets — no autopay unless user explicitly schedules them
- payments[].recipientHint must include concrete details, e.g. "08131208415 MTN", "1234567890 IKEDC", "9072672767 Opay", "@freddy001", "Wally Paul · 9072672767 Opay"
- Never use DayEarn as a send recipient
- Calculate days left in period
- Compare plan total (in USD after server conversion) to USD global wallet; set suggestSwap: true if insufficient
- Suggest locking Rent, School Fees, Emergency, Savings categories
- Set readyToApprove true ONLY when every autoSend payment has recipientHint filled AND all account details are complete
- Include budgetType in planDraft when known (weekly|monthly|annual|custom)
- Do NOT set readyToApprove if autopay payments lack bank/Opay/tag/phone details

## Before readyToApprove (CRITICAL checklist)
Every autoSend payment must have ALL of:
1. recipientHint — verified @username, bank+account, Opay/phone, or bill meter/phone+provider
2. nextRunAt — ISO-8601 timestamp OR dueLabel that resolves (tomorrow, every Saturday, Jun 14)
3. amount — USD wallet debit (after amountCurrency conversion)
4. sourceAmount + toCurrency — when user spoke NGN or delivery is non-USD (e.g. toCurrency: "NGN", sourceAmount: 5000, amount: 3.25)

## planDraft fields
amountCurrency ("NGN"|"USD"), budgetType, title, periodLabel, totalBudget, categories[{name, allocated, locked?, sourceAmount?}], payments[{title, amount, sourceAmount?, dueLabel?, nextRunAt?, toCurrency?, recipientHint?, autoSend?}], leftover, sweepToDayEarn, readyToApprove, goals[{title, targetAmount, monthlyTarget?}]

Start NEW conversations (empty history) with a short welcome. If wallet balance > 0, mention they can tell you what to cover — do NOT demand income first.

Respond ONLY with valid JSON:
{
  "reply": "chat text",
  "planDraft": { ... },
  "suggestSwap": false,
  "insights": ["optional insight strings"]
}
`.trim();

const DAYFLOW_ADD_ITEM_MODE = `
## Mode: Add new item (WhatsApp-style chat — CRITICAL)
The user is adding ONE budget item or scheduled payment through chat only. No external screens.

### Conversation rules
- Ask ONE short question per turn. Sound like WhatsApp, not a form.
- Collect everything in reply text first. Do NOT show a review card in JSON until setup is complete.
- OMIT planDraft from your JSON response until the user has confirmed the final summary. Earlier turns: reply only (planDraft must be null or omitted).
- Never set readyToApprove: true until the checklist above is complete AND the user confirmed the summary.

### Sending money to a person (Jane, mom, friend, etc.)
1. Acknowledge amount + schedule from their message.
2. Ask how they want to send: "Dayfi @username", bank transfer, or mobile money (Opay/PalmPay/etc.).
3. Ask destination country/currency if unclear (NGN bank, USD, etc.).
4. Ask for the specific detail: @username, account number + bank name, or phone + provider.
5. Repeat back to verify: "Sending $4 to Jane (9072672767 · Opay) tomorrow — look good?"
6. Only after they confirm → include planDraft with readyToApprove: true, payments[].autoSend: true, full recipientHint, nextRunAt (ISO), toCurrency when not USD, and sourceAmount when user spoke NGN or delivery is NGN.

### Bills & subscriptions
- Ask provider/biller and account or meter/phone number in chat before planDraft.
- Verify once, then planDraft with readyToApprove: true.

### Spending pockets (no autopay)
- Categories without autoSend do not need recipientHint. planDraft can use readyToApprove: true when amounts are clear.

### Examples
- User: "Send $4 to Jane tomorrow" → reply: "Got it — $4 to Jane tomorrow. How should Jane receive it: Dayfi @username, bank transfer, or mobile money?" (no planDraft)
- User: "Bank transfer" → "Which bank and account number for Jane?" (no planDraft)
- User: "GTBank 0123456789" → "Sending $4 to Jane (0123456789 · GTBank) tomorrow — correct?" (no planDraft)
- User: "Yes" → include planDraft with payment and readyToApprove: true
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
    return process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';
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

function inferInputCurrencyFromText(text: string): DayFlowInputCurrency | null {
  const t = text.toLowerCase();
  const hasNgn =
    /₦|naira|ngn\b/.test(t) ||
    /\d+\s*k\b(?!\s*dollar)/.test(t) ||
    /\d+k\s*(naira|ngn)?/.test(t) ||
    /thousand\s+naira/.test(t) ||
    /hundred\s+naira/.test(t);
  const hasUsd =
    /\$|dollar|usd\b/.test(t) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)\s+dollars?\b/.test(
      t
    );

  if (hasUsd && !hasNgn) return 'USD';
  if (hasNgn && !hasUsd) return 'NGN';
  return null;
}

function resolveInputCurrency(
  raw: Record<string, unknown> | undefined,
  message: string,
  history: DayFlowHistoryMessage[]
): DayFlowInputCurrency {
  const explicit = String(raw?.amountCurrency ?? '')
    .trim()
    .toUpperCase();
  if (explicit === 'USD' || explicit === 'NGN') {
    return explicit as DayFlowInputCurrency;
  }

  const userText = [
    ...history.filter((h) => h.role === 'user').map((h) => h.content),
    message,
  ].join(' ');
  return inferInputCurrencyFromText(userText) ?? 'USD';
}

function sumPlanLineAmounts(draft: DayFlowPlanDraft): number {
  const categoryTotal = draft.categories.reduce(
    (s, c) => s + Number(c.allocated ?? 0),
    0
  );
  const paymentTotal = draft.payments.reduce(
    (s, p) => s + Number(p.amount ?? 0),
    0
  );
  return categoryTotal + paymentTotal;
}

function ensurePlanTotals(draft: DayFlowPlanDraft): DayFlowPlanDraft {
  const lineTotal = sumPlanLineAmounts(draft);
  if (draft.totalBudget > 0 || lineTotal <= 0) return draft;
  return { ...draft, totalBudget: lineTotal };
}

function buildSystemPrompt(
  usdBalance: number,
  activePlanSummary: string,
  conversationSummary?: string,
  mode?: DayFlowChatMode
): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysLeftInMonth = daysInMonth - dayOfMonth;
  const summaryBlock = conversationSummary
    ? `\n\n## ${conversationSummary}`
    : '';

  const modeBlock =
    mode === 'addItem'
      ? `\n\n${DAYFLOW_ADD_ITEM_MODE}`
      : mode === 'editBudget'
        ? '\n\n## Mode: Edit budget\nUpdate the existing plan in chat. Only set readyToApprove when all autopay rows have recipientHint.'
        : '';

  return `${DAYFLOW_SYSTEM}${modeBlock}

Context (authoritative):
- Today: ${dateStr} (${monthName})
- Days left in this calendar month: ${daysLeftInMonth}
- User global wallet balance (USD ledger): $${usdBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Active DayFlow plan: ${activePlanSummary}
- Plans are budgeted in USD from the global wallet. Users may speak NGN — set amountCurrency accordingly. If USD-equivalent budget exceeds wallet, mention insufficient balance and set suggestSwap: true.
- Remember prior turns in this chat — do not re-ask for information the user already gave (amounts, categories, item names).${summaryBlock}`;
}

function parsePlanDraft(
  raw: unknown,
  inputCurrency: DayFlowInputCurrency
): DayFlowPlanDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const categories = Array.isArray(p.categories)
    ? p.categories
        .filter((c) => c && typeof c === 'object')
        .map((c) => {
          const row = c as Record<string, unknown>;
          return {
            name: String(row.name ?? ''),
            allocated: Number(row.allocated ?? 0),
          };
        })
    : [];
  const payments = Array.isArray(p.payments)
    ? p.payments
        .filter((pay) => pay && typeof pay === 'object')
        .map((pay) => {
          const row = pay as Record<string, unknown>;
          return {
            title: String(row.title ?? ''),
            amount: Number(row.amount ?? 0),
            sourceAmount:
              row.sourceAmount != null
                ? Number(row.sourceAmount)
                : undefined,
            dueLabel: row.dueLabel ? String(row.dueLabel) : undefined,
            nextRunAt: row.nextRunAt ? String(row.nextRunAt) : undefined,
            toCurrency: row.toCurrency ? String(row.toCurrency) : undefined,
            recipientHint: row.recipientHint
              ? String(row.recipientHint)
              : undefined,
            autoSend: row.autoSend === true,
          };
        })
    : [];

  if (!p.totalBudget && categories.length === 0 && payments.length === 0) {
    return undefined;
  }

  let readyToApprove = p.readyToApprove === true;

  return {
    title: String(p.title ?? "This Month's Plan"),
    periodLabel: String(p.periodLabel ?? 'This Month'),
    totalBudget: Number(p.totalBudget ?? 0),
    currency: 'USD',
    inputCurrency,
    categories,
    payments,
    leftover: Number(p.leftover ?? 0),
    sweepToDayEarn: p.sweepToDayEarn === true,
    readyToApprove,
  };
}

function finalizeReadyToApprove(
  draft: DayFlowPlanDraft,
  requested: boolean
): boolean {
  if (!requested) return false;
  const check = validatePlanDraftForCreate(draft);
  return check.ok;
}

export function getDayflowStatus() {
  const provider = resolveProvider();
  const enabled = aiConfigured();
  return {
    enabled,
    mode: enabled ? 'full' : 'local',
    provider: enabled ? provider : 'rules',
    model: enabled ? resolveModel(provider) : null,
  };
}

export type DayFlowChatMode = 'addItem' | 'editBudget' | 'general';

export async function chatWithDayflow(params: {
  userId: string;
  message: string;
  history?: DayFlowHistoryMessage[];
  mode?: DayFlowChatMode;
}): Promise<DayFlowChatResult> {
  const message = params.message.trim();
  if (!message) {
    return {
      reply:
        "Hi, I'm DayFlow. How much money do you have to work with this month or this week?",
      meta: { provider: 'rules', mode: 'local' },
    };
  }

  if (!aiConfigured()) {
    throw new Error('DAYFLOW_AI_UNAVAILABLE');
  }

  const provider = resolveProvider();
  const [usdBalance, activePlan] = await Promise.all([
    loadUsdBalance(params.userId),
    getActivePlan(params.userId),
  ]);
  const planSummary = activePlan
    ? `${activePlan.periodLabel} — $${activePlan.totalBudget} budget, $${activePlan.spent} spent, safe categories: ${(activePlan.categories as { name: string }[]).map((c) => c.name).join(', ')}`
    : 'None yet';
  const history = (params.history ?? []).slice(-16);
  const conversationSummary = buildConversationSummary(history);
  const mode = params.mode ?? 'general';
  const system = buildSystemPrompt(
    usdBalance,
    planSummary,
    conversationSummary,
    mode
  );

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
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
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
    "How much money do you have to work with this month or this week?";

  const rawDraft =
    payload.planDraft && typeof payload.planDraft === 'object'
      ? (payload.planDraft as Record<string, unknown>)
      : undefined;
  const resolvedCurrency = resolveInputCurrency(rawDraft, message, history);
  let planDraft = parsePlanDraft(payload.planDraft, resolvedCurrency);
  const suggestSwap = payload.suggestSwap === true;

  if (planDraft) {
    const requestedApprove = planDraft.readyToApprove;
    planDraft = await normalizePlanDraftToUsd(planDraft, resolvedCurrency);
    planDraft = ensurePlanTotals(planDraft);
    planDraft = {
      ...planDraft,
      readyToApprove: finalizeReadyToApprove(planDraft, requestedApprove),
    };
  }

  if (planDraft && planDraft.totalBudget > usdBalance && usdBalance >= 0) {
    planDraft = {
      ...planDraft,
      readyToApprove:
        planDraft.readyToApprove && usdBalance >= planDraft.totalBudget,
    };
  }

  // Add-item chat: keep collection in messages only — no plan card until review.
  if (mode === 'addItem' && planDraft && !planDraft.readyToApprove) {
    planDraft = undefined;
  }

  return {
    reply,
    planDraft,
    suggestSwap:
      suggestSwap ||
      (planDraft != null && planDraft.totalBudget > usdBalance),
    meta: { provider, mode: 'full' },
  };
}
