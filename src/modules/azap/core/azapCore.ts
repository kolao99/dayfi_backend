import crypto from 'crypto';
import {
  findCapabilityByCommand,
  formatCapabilityMenu,
  formatHelpMessage,
  isSlashDiscovery,
} from '../capabilities/registry';
import {
  createEmptyActionPlan,
  type AzapActionPlan,
} from '../actionPlan/types';
import { validateActionPlan } from '../actionPlan/validator';
import { createLlmProviderFromEnv } from '../llm/provider';
import {
  formatChargesMessage,
  getAzapCharges,
  isChargesQuery,
} from '../pricing/pricingService';
import { resolveEntityAlias, formatEntityNotFound } from '../entities/aliasService';

export type AzapCoreReply = {
  content: string;
  /** When set, existing four engine / handlers should continue with this text */
  continueWithText?: string;
  handled: boolean;
};

/**
 * Thin Azap conversation entry.
 * Handles capability discovery, help, charges, and entity-aware pre-checks.
 * Money execution remains in existing four/payment services.
 */
export async function handleAzapUtterance(input: {
  userId: string;
  conversationId: string;
  text: string;
}): Promise<AzapCoreReply> {
  const text = String(input.text || '').trim();

  if (isSlashDiscovery(text)) {
    return { handled: true, content: formatCapabilityMenu() };
  }

  if (text.toLowerCase() === '/help' || text.toLowerCase() === 'help') {
    return { handled: true, content: formatHelpMessage() };
  }

  if (isChargesQuery(text)) {
    const quotes = await getAzapCharges();
    return { handled: true, content: formatChargesMessage(quotes) };
  }

  const capability = findCapabilityByCommand(text);
  if (capability) {
    if (capability.handler === 'help') {
      return { handled: true, content: formatHelpMessage() };
    }
    if (capability.handler === 'pricing_request') {
      const quotes = await getAzapCharges();
      return { handled: true, content: formatChargesMessage(quotes) };
    }
    // Map slash shortcuts into phrases the existing four engine already understands.
    const bridge: Record<string, string> = {
      get_balance: 'Check my balance',
      fiat_funding: 'Fund my wallet',
      bank_transfer: 'Send money',
      kyc: '/kyc',
      airtime_purchase: 'Buy airtime',
      bill_payment: 'Pay a bill',
    };
    const continueWithText = bridge[capability.handler];
    if (continueWithText) {
      return {
        handled: false,
        content: '',
        continueWithText,
      };
    }
    return {
      handled: true,
      content:
        `${capability.name} is on Azap's roadmap.\n` +
        `For now, try telling me in plain English — or type / to see what's live.`,
    };
  }

  return { handled: false, content: '' };
}

export async function proposeActionPlanFromText(input: {
  userId: string;
  conversationId: string;
  text: string;
}): Promise<AzapActionPlan> {
  const llm = createLlmProviderFromEnv();
  const proposed = await llm.planActions({
    userId: input.userId,
    conversationId: input.conversationId,
    text: input.text,
  });

  let plan = createEmptyActionPlan({
    id: `azap_plan_${crypto.randomBytes(6).toString('hex')}`,
    conversationId: input.conversationId,
    userId: input.userId,
  });
  plan = {
    ...plan,
    ...proposed.plan,
    id: plan.id,
    conversationId: input.conversationId,
    userId: input.userId,
    actions: proposed.plan.actions,
    createdAt: plan.createdAt,
    updatedAt: new Date().toISOString(),
  };

  const validated = validateActionPlan(plan);
  return validated.plan;
}

/** Pre-resolve nickname recipients before falling into four send flow. */
export async function tryResolveRecipientAlias(input: {
  userId: string;
  name: string;
}): Promise<{ ok: true; targetId: string; label: string } | { ok: false; message: string }> {
  const resolution = await resolveEntityAlias({
    userId: input.userId,
    kind: 'recipient',
    alias: input.name,
  });
  if (resolution.status === 'resolved') {
    return {
      ok: true,
      targetId: resolution.alias.targetId,
      label: resolution.alias.displayLabel,
    };
  }
  if (resolution.status === 'ambiguous') {
    const lines = resolution.matches.map((m) => `• ${m.displayLabel}`);
    return {
      ok: false,
      message:
        `I found more than one recipient saved as ${input.name}:\n\n` +
        `${lines.join('\n')}\n\nWhich one do you mean?`,
    };
  }
  return {
    ok: false,
    message: formatEntityNotFound({ alias: input.name, kind: 'recipient' }),
  };
}
