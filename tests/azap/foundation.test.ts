import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  findCapabilityByCommand,
  formatCapabilityMenu,
  formatHelpMessage,
  isSlashDiscovery,
  listEnabledCapabilities,
} from '../../src/modules/azap/capabilities/registry';
import {
  AZAP_MAX_ACTIONS,
  assertActionPlanLimits,
  createEmptyActionPlan,
  summarizePartialFailure,
} from '../../src/modules/azap/actionPlan/types';
import { validateActionPlan } from '../../src/modules/azap/actionPlan/validator';
import { StubLLMProvider } from '../../src/modules/azap/llm/stubProvider';
import {
  formatEntityAmbiguous,
  formatEntityNotFound,
} from '../../src/modules/azap/entities/aliasService';
import { formatChargesMessage } from '../../src/modules/azap/pricing/pricingService';
import { assertToolAllowed, getTool } from '../../src/modules/azap/tools/registry';
import { handleAzapUtterance } from '../../src/modules/azap/core/azapCore';

describe('azap foundation', () => {
  it('capability registry powers slash discovery and help', () => {
    expect(isSlashDiscovery('/')).to.equal(true);
    expect(findCapabilityByCommand('/balance')?.handler).to.equal(
      'get_balance'
    );
    const menu = formatCapabilityMenu();
    expect(menu).to.include('What can Azap do for you?');
    expect(menu).to.include('/balance');
    expect(menu).to.not.match(/\bMONY\b/i);
    expect(formatHelpMessage()).to.include('Type / to explore commands');
    expect(listEnabledCapabilities().length).to.be.greaterThan(10);
  });

  it('ActionPlan enforces max 4 actions and validates flags', () => {
    const plan = createEmptyActionPlan({
      id: 'p1',
      conversationId: 'c1',
      userId: 'u1',
    });
    plan.actions = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      type: 'bank_transfer' as const,
      status: 'draft' as const,
      amount: '1000',
      recipientReference: 'Kola',
    }));
    expect(assertActionPlanLimits(plan).ok).to.equal(false);
    expect(AZAP_MAX_ACTIONS).to.equal(4);

    plan.actions = plan.actions.slice(0, 2);
    plan.actions[0].amount = null;
    const validated = validateActionPlan(plan);
    expect(validated.plan.requiresResolution).to.equal(true);
    expect(validated.plan.requiresPin).to.equal(true);
  });

  it('stub LLM maps NL to ActionPlan without moving money', async () => {
    const llm = new StubLLMProvider();
    const result = await llm.planActions({
      userId: 'u1',
      conversationId: 'c1',
      text: "What's my balance?",
    });
    expect(result.plan.actions[0].type).to.equal('balance_check');

    const send = await llm.planActions({
      userId: 'u1',
      conversationId: 'c1',
      text: 'Send 2k to Kola',
    });
    expect(send.plan.actions[0].type).to.equal('bank_transfer');
    expect(send.plan.actions[0].recipientReference).to.equal('Kola');
    expect(send.plan.requiresPin).to.equal(true);
  });

  it('entity not-found and ambiguous copy are user-facing', () => {
    expect(formatEntityNotFound({ alias: 'Kola', kind: 'recipient' })).to.include(
      'Add Kola'
    );
    expect(
      formatEntityAmbiguous({
        alias: 'Kola',
        matches: [
          {
            id: '1',
            userId: 'u',
            kind: 'recipient',
            alias: 'Kola',
            targetId: 't1',
            displayLabel: 'OPay ••••8415',
            metadata: {},
            createdAt: new Date().toISOString(),
          },
          {
            id: '2',
            userId: 'u',
            kind: 'recipient',
            alias: 'Kola',
            targetId: 't2',
            displayLabel: 'GTBank ••••1290',
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ],
      })
    ).to.include('more than one');
  });

  it('pricing and tool gates stay deterministic', () => {
    const msg = formatChargesMessage([
      {
        service: 'bank_transfer',
        currency: 'NGN',
        fee: 0,
        description: 'Instant bank transfer',
      },
    ]);
    expect(msg).to.include('Azap Charges');
    const tool = getTool('create_bank_transfer');
    expect(tool?.risk).to.equal('high');
    expect(
      assertToolAllowed(tool!, { pinVerified: false, kycVerified: true }).ok
    ).to.equal(false);
  });

  it('partial failure summary never claims full success', () => {
    const plan = createEmptyActionPlan({
      id: 'p',
      conversationId: 'c',
      userId: 'u',
    });
    plan.actions = [
      {
        id: '1',
        type: 'bank_transfer',
        status: 'succeeded',
        recipientReference: 'Kola',
      },
      {
        id: '2',
        type: 'airtime_purchase',
        status: 'failed',
        phoneReference: 'self',
        errorMessage: '₦500 airtime — provider declined',
      },
    ];
    const text = summarizePartialFailure(plan);
    expect(text).to.include('1 of 2');
    expect(text).to.include('not treated as successful');
  });

  it('azap core handles / and /help without four money path', async () => {
    const menu = await handleAzapUtterance({
      userId: 'u',
      conversationId: 'c',
      text: '/',
    });
    expect(menu.handled).to.equal(true);
    expect(menu.content).to.include('/balance');

    const help = await handleAzapUtterance({
      userId: 'u',
      conversationId: 'c',
      text: '/help',
    });
    expect(help.handled).to.equal(true);
    expect(help.content).to.include('Money');
  });
});
