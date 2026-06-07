import axios from 'axios';
import { buildConversationSummary } from '../dayx/dayxConversationSummary';
import { PRIMARY_CURRENCY } from '../payment/walletModel';
import {
  loadUsdBalance,
  normalizePlanDraftToUsd,
  type DayFlowInputCurrency,
} from './dayflowCurrency';
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
- The server converts NGN → USD using live rates; you do NOT need to convert in the JSON
- Example: user says "send ₦200,000 every Friday" → payments[].amount: 200000, amountCurrency: "NGN"
- Example: rent ₦900,000 split 3 ways → user's share ₦300,000 → categories Rent allocated: 300000 OR payments[] with amount 300000, amountCurrency: "NGN"
- For rent splits: ask how many people split, compute each person's share accurately, emit one payment[] row per roommate autopay when requested
- In reply text, show both when helpful: "₦200,000 (~$130 from your global wallet)" using rate ~₦1540 = $1

## Rules
- Ask clarifying questions before full plan (income amount, split details, recipient accounts)
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

## planDraft fields
amountCurrency ("NGN"|"USD"), budgetType, title, periodLabel, totalBudget, categories[{name, allocated, locked?}], payments[{title, amount, dueLabel?, recipientHint?, autoSend?}], leftover, sweepToDayEarn, readyToApprove, goals[{title, targetAmount, monthlyTarget?}]

Start NEW conversations (empty history) with:
"Hi, I'm DayFlow. How much money do you have to work with this month or this week?"

Respond ONLY with valid JSON:
{
  "reply": "chat text",
  "planDraft": { ... },
  "suggestSwap": false,
  "insights": ["optional insight strings"]
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

function buildSystemPrompt(
  usdBalance: number,
  activePlanSummary: string,
  conversationSummary?: string
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

  return `${DAYFLOW_SYSTEM}

Context (authoritative):
- Today: ${dateStr} (${monthName})
- Days left in this calendar month: ${daysLeftInMonth}
- User global wallet balance (USD ledger): $${usdBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Active DayFlow plan: ${activePlanSummary}
- Plans are budgeted in USD from the global wallet. Users may speak NGN — set amountCurrency accordingly. If USD-equivalent budget exceeds wallet, mention insufficient balance and set suggestSwap: true.
- Remember prior turns in this chat — do not re-ask for information the user already gave (amounts, categories, item names).${summaryBlock}`;
}

function parsePlanDraft(raw: unknown): DayFlowPlanDraft | undefined {
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
            dueLabel: row.dueLabel ? String(row.dueLabel) : undefined,
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

  const inputCurrency: DayFlowInputCurrency =
    String(p.amountCurrency ?? 'NGN').toUpperCase() === 'USD' ? 'USD' : 'NGN';

  const readyToApprove =
    p.readyToApprove === true &&
    payments.every(
      (pay) =>
        !pay.autoSend ||
        Boolean(pay.recipientHint && String(pay.recipientHint).trim())
    );

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

export async function chatWithDayflow(params: {
  userId: string;
  message: string;
  history?: DayFlowHistoryMessage[];
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
  const system = buildSystemPrompt(usdBalance, planSummary, conversationSummary);

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

  let planDraft = parsePlanDraft(payload.planDraft);
  const suggestSwap = payload.suggestSwap === true;

  if (planDraft) {
    planDraft = await normalizePlanDraftToUsd(
      planDraft,
      planDraft.inputCurrency ?? 'NGN'
    );
  }

  if (planDraft && planDraft.totalBudget > usdBalance && usdBalance >= 0) {
    planDraft = {
      ...planDraft,
      readyToApprove:
        planDraft.readyToApprove && usdBalance >= planDraft.totalBudget,
    };
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
