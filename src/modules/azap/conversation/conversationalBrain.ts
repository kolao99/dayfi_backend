/**
 * Azap conversational brain — ChatGPT-like understanding within DayFi bounds.
 *
 * LLM reasons and replies. Backend still validates/executes money.
 * Deterministic intent FSMs remain for in-progress money collection.
 */

import { createLlmProviderFromEnv } from '../llm/provider';
import type { LlmChatMessage, LlmPlanResult } from '../llm/provider';
import { listMessages } from '../../four/conversation/messageService';
import { assistantName } from '../../four/brand';
import { parseUserMessage } from '../../four/engine/intentParser';
import {
  capabilityFactsForPrompt,
  tryAnswerCapabilityQuestion,
} from './solutionOriented';
import { getLastMoneyContext } from './dialogueContext';
import { getActiveIntentForConversation } from '../../four/intent/intentService';

export type BrainAction = LlmPlanResult['plan']['actions'][number];

export type BrainResult =
  | { kind: 'chat'; reply: string; source: 'llm' | 'capability' | 'fallback' }
  | { kind: 'action'; actions: BrainAction[]; note?: string; source: 'llm' | 'parser' };

function scrubUnsafeClaims(text: string): string {
  let out = String(text || '').trim();
  out = out.replace(
    /\b(i('ve| have)? (just )?(sent|transferred|paid|completed|saved|funded)|your (new )?balance is|₦\s*[\d,]+ (has been|was) sent|transaction (hash|id) is)\b[^.!?\n]*/gi,
    ''
  );
  out = out.replace(/\bplease (select an option|use \/menu|provide a valid)\b[^.!?\n]*/gi, '');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out.slice(0, 900);
}

function brainSystemPrompt(activeSummary: string): string {
  const brand = assistantName();
  return (
    `You are ${brand} by Dayfi — a highly capable conversational money assistant on WhatsApp for Africa.\n` +
    `Intelligence standard: understand ANY reasonable message like ChatGPT would — greetings, jokes, slang, Pidgin, questions, corrections, incomplete thoughts.\n` +
    `Personality: Nigerian-natural, concise, warm, confident. Never corporate. Never dump /menu unless user typed / or /menu.\n` +
    `Continuously ask: what is this person trying to accomplish, and what is the most helpful next thing?\n` +
    `If blocked: acknowledge → explain → offer closest useful solution → ask minimum next step.\n` +
    `You NEVER execute money, invent balances/rates/hashes, claim sent/saved/funded, or ask for PIN in chat.\n` +
    `Product facts (backend source of truth): ${capabilityFactsForPrompt()}\n` +
    `Active workflow context: ${activeSummary || 'none'}.\n` +
    `Return JSON only:\n` +
    `{"mode":"chat"|"action","reply":string|null,"actions":[{"type":"bank_transfer|crypto_deposit|crypto_transfer|fiat_funding|balance_check|airtime_purchase|bill_payment|kyc","amount":string|null,"currency":string|null,"recipientReference":string|null,"asset":string|null,"network":string|null}]}\n` +
    `Use mode=chat for conversation, explanations, recommendations, capability Qs, jokes, empathy, clarification.\n` +
    `Use mode=action ONLY when the user clearly wants an executable financial step now (send/fund/balance/bill/airtime/kyc/crypto deposit).\n` +
    `Prefer chat when unsure. Max 1 action. reply is required for chat; optional short note for action.`
  );
}

function mapActions(raw: unknown): BrainAction[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set([
    'bank_transfer',
    'crypto_deposit',
    'crypto_transfer',
    'fiat_funding',
    'balance_check',
    'airtime_purchase',
    'bill_payment',
    'kyc',
    'crypto_buy',
    'crypto_sell',
    'crypto_swap',
  ]);
  const out: BrainAction[] = [];
  for (const item of raw.slice(0, 1)) {
    const a = (item ?? {}) as Record<string, unknown>;
    const type = String(a.type || a.action || '').trim();
    if (!allowed.has(type)) continue;
    out.push({
      id: `brain_action_${out.length + 1}`,
      type: type as BrainAction['type'],
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
    });
  }
  return out;
}

function normalizeBrainResult(result: BrainResult): BrainResult {
  if (result.kind === 'chat') {
    return {
      ...result,
      reply: scrubUnsafeClaims(result.reply),
    };
  }
  const actions = mapActions(result.actions);
  return {
    kind: 'action',
    actions,
    note: result.note ? scrubUnsafeClaims(result.note) : undefined,
    source: result.source,
  };
}

async function buildHistory(
  userId: string,
  conversationId: string,
  system: string,
  text: string
): Promise<LlmChatMessage[]> {
  const messages: LlmChatMessage[] = [{ role: 'system', content: system }];
  try {
    const page = await listMessages(userId, conversationId, { limit: 16 });
    for (const m of page?.messages || []) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const content = String(m.content || '').trim();
      if (!content) continue;
      messages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: content.slice(0, 500),
      });
    }
  } catch {
    /* optional */
  }
  messages.push({ role: 'user', content: text.slice(0, 700) });
  return messages;
}

function stubBrain(text: string, firstName?: string): BrainResult {
  const capability = tryAnswerCapabilityQuestion(text);
  if (capability) {
    return { kind: 'chat', reply: capability, source: 'capability' };
  }

  const parsed = parseUserMessage(text);
  if (
    parsed.kind === 'balance' ||
    parsed.kind === 'balance_in_currency' ||
    parsed.kind === 'send' ||
    parsed.kind === 'send_prompt' ||
    parsed.kind === 'fund' ||
    parsed.kind === 'bill_prompt' ||
    parsed.kind === 'airtime_prompt' ||
    parsed.kind === 'kyc'
  ) {
    // Let the engine's deterministic path handle these when it can;
    // as brain fallback, only emit action for clear send/balance/fund.
    if (parsed.kind === 'balance' || parsed.kind === 'balance_in_currency') {
      return {
        kind: 'action',
        source: 'parser',
        actions: [
          {
            id: 'brain_action_1',
            type: 'balance_check',
            status: 'ready',
          },
        ],
      };
    }
    if (parsed.kind === 'fund') {
      return {
        kind: 'action',
        source: 'parser',
        actions: [
          {
            id: 'brain_action_1',
            type: 'fiat_funding',
            status: 'ready',
          },
        ],
      };
    }
    if (parsed.kind === 'send' || parsed.kind === 'send_prompt') {
      return {
        kind: 'action',
        source: 'parser',
        actions: [
          {
            id: 'brain_action_1',
            type: 'bank_transfer',
            status: 'needs_resolution',
            amount:
              parsed.kind === 'send' && parsed.amount != null
                ? String(parsed.amount)
                : null,
            currency: 'NGN',
            recipientReference:
              parsed.kind === 'send' ? parsed.recipientName : null,
          },
        ],
      };
    }
  }

  const name = String(firstName || '')
    .trim()
    .split(/\s+/)[0];
  const safe =
    name && !/^(there|friend|user)$/i.test(name) ? name : '';
  const q = text.toLowerCase();

  let reply: string;
  if (/^(hi|hey|hello|yo|yoo)\b/.test(q)) {
    reply = `Hey${safe ? ` ${safe}` : ''} 👋 How you doing?`;
  } else if (/^(good|fine|okay|ok|great|solid|sharp)[.!\s😂]*$/i.test(text)) {
    reply = `Love that. What are we sorting out today?`;
  } else if (/paid|salary|just got/i.test(q)) {
    reply = `Love that 😂 What are we doing with the money?`;
  } else if (/tired|stress|wahala|broke/i.test(q)) {
    reply = `I feel you 🙏 Want help sorting money stuff, or just venting?`;
  } else if (/thanks|thank you|thx|never mind|nvm/i.test(q)) {
    reply = /never mind|nvm/i.test(q)
      ? `No wahala. I'm here if you need anything.`
      : `Anytime 🙌`;
  } else if (/😂|lol|lmao/.test(text) && text.length < 8) {
    reply = `😂 I'm with you. What next?`;
  } else if (/explain|what('?s| is) the difference|like i'?m five|recommend|should i/i.test(q)) {
    reply =
      `I can walk you through it. Tell me a bit more about what you're trying to figure out — ` +
      `crypto, transfers, funding, or bills — and I'll keep it simple.`;
  } else if (/abeg help|help me|i don't know|idk/i.test(q)) {
    reply =
      `I got you. We can send money, fund your wallet, check balances, do airtime/bills, or talk crypto (USDC/EURC). What do you want to sort first?`;
  } else {
    reply =
      `I hear you. Tell me more — or if you want, we can send money, check your balance, fund your wallet, or handle a bill.`;
  }

  return { kind: 'chat', reply, source: 'fallback' };
}

/**
 * Reason about an utterance. Prefer LLM when configured; never executes money.
 */
export async function runConversationalBrain(input: {
  userId: string;
  conversationId: string;
  text: string;
  firstName?: string;
}): Promise<BrainResult> {
  const text = String(input.text || '').trim();
  if (!text) {
    return {
      kind: 'chat',
      reply: "I'm here — what do you want to sort out?",
      source: 'fallback',
    };
  }

  // Deterministic capability answers when we have a clear product question.
  const capability = tryAnswerCapabilityQuestion(text);
  if (capability) {
    return { kind: 'chat', reply: capability, source: 'capability' };
  }

  let activeSummary = 'none';
  try {
    const active = await getActiveIntentForConversation(
      input.userId,
      input.conversationId
    );
    const last = await getLastMoneyContext(input.conversationId);
    if (active) {
      const slots = (active.slots || {}) as Record<string, unknown>;
      activeSummary = JSON.stringify({
        intent: active.intent,
        status: active.status,
        amount: slots.amount ?? null,
        pendingRecipientLabel: slots.pendingRecipientLabel ?? null,
        hasRecipient: Boolean(slots.recipient),
      });
    } else if (last?.recipientName) {
      activeSummary = JSON.stringify({
        lastRecipient: last.recipientName,
        lastAmount: last.amount ?? null,
      });
    }
  } catch {
    /* optional */
  }

  const llm = createLlmProviderFromEnv();
  const system = brainSystemPrompt(activeSummary);
  const messages = await buildHistory(
    input.userId,
    input.conversationId,
    system,
    text
  );

  // Prefer provider.reason when available; else JSON via complete.
  try {
    if (typeof (llm as { reason?: Function }).reason === 'function') {
      const reasoned = await (
        llm as {
          reason: (msgs: LlmChatMessage[]) => Promise<BrainResult | null>;
        }
      ).reason(messages);
      if (reasoned) {
        const normalized = normalizeBrainResult(reasoned);
        if (normalized.kind === 'action' && !normalized.actions.length) {
          // Unsupported proposal → stay in chat rather than no-op execute.
          return {
            kind: 'chat',
            reply:
              "I can't do that exact action yet. I can help with transfers, funding, USDC/EURC, bills, or your balance — what do you want to sort?",
            source: 'fallback',
          };
        }
        return normalized;
      }
    }
  } catch (err) {
    console.warn(
      '[azap/brain] reason failed',
      err instanceof Error ? err.message : err
    );
  }

  try {
    if (llm.complete) {
      const raw = await llm.complete([
        ...messages.slice(0, 1),
        {
          role: 'system',
          content:
            messages[0].content +
            '\nRespond with the JSON object only. If chatting, put the user-facing text in "reply".',
        },
        ...messages.slice(1),
      ]);
      const cleaned = raw.trim();
      if (cleaned.startsWith('{')) {
        const parsed = JSON.parse(cleaned) as {
          mode?: string;
          reply?: string;
          actions?: unknown;
        };
        const actions = mapActions(parsed.actions);
        if (
          String(parsed.mode || '').toLowerCase() === 'action' &&
          actions.length
        ) {
          return {
            kind: 'action',
            actions,
            note: scrubUnsafeClaims(String(parsed.reply || '')),
            source: 'llm',
          };
        }
        const reply = scrubUnsafeClaims(String(parsed.reply || ''));
        if (reply.length >= 2) {
          return { kind: 'chat', reply, source: 'llm' };
        }
      } else {
        const reply = scrubUnsafeClaims(cleaned);
        if (reply.length >= 2) {
          return { kind: 'chat', reply, source: 'llm' };
        }
      }
    }
  } catch (err) {
    console.warn(
      '[azap/brain] llm parse failed',
      err instanceof Error ? err.message : err
    );
  }

  return stubBrain(text, input.firstName);
}

/** Test helper — scrub fabricated money claims from model output. */
export function scrubBrainReplyForTests(text: string): string {
  return scrubUnsafeClaims(text);
}
