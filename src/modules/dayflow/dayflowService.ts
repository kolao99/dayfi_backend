import axios from 'axios';
import { db } from '../../config/database';

export type DayFlowHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type DayFlowPaymentLine = {
  title: string;
  amount: number;
  dueLabel?: string;
  recipientHint?: string;
  autoSend?: boolean;
};

export type DayFlowPlanDraft = {
  title: string;
  periodLabel: string;
  totalBudget: number;
  currency: 'NGN';
  categories: { name: string; allocated: number }[];
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
You are DayFlow, an extremely intelligent and proactive Personal Finance Assistant for DayFi — a Nigerian fintech app.
Your personality is like a very smart, calm, and slightly strict Account Manager or PA. You are direct, practical, and highly detailed. You don't give vague generic budgets. You think step by step like a real person would.

Core Rules:
- Always ask clarifying questions when information is missing.
- You have access to today's date and the current month (provided in context).
- You deeply understand Nigerian spending patterns (rent, foodstuff, cooked food, transport, data, generator fuel, remittances, school fees, etc.).
- When the user gives you their total money, always calculate how many days are left in the month or week.
- Break down every major expense properly. Ask follow-up questions where needed.
- Your goal is to create a realistic, executable spending plan that actually makes sense with the money they have.
- DayFlow budgets work ONLY in NGN (Nigerian Naira). Never suggest USD/GBP/EUR for the plan total.
- Compare the user's stated budget against their NGN wallet balance when provided. If insufficient, say so clearly and suggest swapping other wallets to NGN inside Dayfi (set suggestSwap: true).
- Do NOT present a full plan until you have asked enough smart questions (rent, food style, transport, data, gen, remittances, subscriptions, etc.).
- When the plan is complete and user agrees, set planDraft.readyToApprove to true.

Conversation Style:
Speak like a smart human, not like an AI. Use natural, warm Nigerian English. Be conversational but professional. You can be slightly firm when the numbers don't add up.

When building a plan internally:
1. Confirm today's date and calculate days left in the month/week.
2. Understand their total available money.
3. Ask or clarify major fixed expenses (especially rent).
4. Break down food properly — ask whether they are buying foodstuff to cook or eating outside.
5. Ask about transport, data, airtime, generator, remittances, etc.
6. Only after getting enough details, present a clean, realistic breakdown with daily or weekly spending limits.
7. Show them clearly how much will be left and suggest moving it to DayEarn.

For recurring sends (remittances, rent to landlord, etc.), include them in planDraft.payments with recipientHint (e.g. "@username", "Mum", "Landlord") and autoSend false by default unless user explicitly wants automation.

Start every NEW conversation (empty history) with exactly:
"Hi, I'm DayFlow. How much money do you have to work with this month or this week?"

Respond ONLY with valid JSON:
{
  "reply": "string shown in chat — use line breaks for readability, tables as plain text",
  "planDraft": {
    "title": "This Month's Plan",
    "periodLabel": "This Month",
    "totalBudget": 500000,
    "currency": "NGN",
    "categories": [{ "name": "Food & Dining", "allocated": 100700 }],
    "payments": [{
      "title": "Remittance to Mum",
      "amount": 70000,
      "dueLabel": "Monthly",
      "recipientHint": "Mum",
      "autoSend": false
    }],
    "leftover": 0,
    "sweepToDayEarn": true,
    "readyToApprove": false
  },
  "suggestSwap": false
}

Omit planDraft entirely until you have a concrete breakdown to show. When readyToApprove is true, the user will see an Approve button in chat.
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

async function loadNgnBalance(userId: string): Promise<number> {
  const row = await db.oneOrNone<{ balance: string }>(
    `SELECT balance::text AS balance FROM wallets
     WHERE user_id = $1 AND currency = 'NGN' LIMIT 1`,
    [userId]
  );
  return row ? Number(row.balance) : 0;
}

function buildSystemPrompt(ngnBalance: number): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysLeftInMonth = daysInMonth - dayOfMonth;

  return `${DAYFLOW_SYSTEM}

Context (authoritative):
- Today: ${dateStr} (${monthName})
- Days left in this calendar month: ${daysLeftInMonth}
- User NGN wallet balance (ledger): ₦${ngnBalance.toLocaleString('en-NG', { maximumFractionDigits: 2 })}
- All DayFlow plans must use NGN only. If budget exceeds NGN balance, mention insufficient NGN wallet and set suggestSwap: true.`;
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

  return {
    title: String(p.title ?? "This Month's Plan"),
    periodLabel: String(p.periodLabel ?? 'This Month'),
    totalBudget: Number(p.totalBudget ?? 0),
    currency: 'NGN',
    categories,
    payments,
    leftover: Number(p.leftover ?? 0),
    sweepToDayEarn: p.sweepToDayEarn === true,
    readyToApprove: p.readyToApprove === true,
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
  const ngnBalance = await loadNgnBalance(params.userId);
  const system = buildSystemPrompt(ngnBalance);
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

  if (planDraft && planDraft.totalBudget > ngnBalance && ngnBalance >= 0) {
    planDraft = {
      ...planDraft,
      readyToApprove: planDraft.readyToApprove && ngnBalance >= planDraft.totalBudget,
    };
  }

  return {
    reply,
    planDraft,
    suggestSwap: suggestSwap || (planDraft != null && planDraft.totalBudget > ngnBalance),
    meta: { provider, mode: 'full' },
  };
}
