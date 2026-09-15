/**
 * Azap 2.0 Phase 1 — conversation routing + natural replies + pronoun send.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  classifyRouteKind,
  isPureGreeting,
  shouldPreferConversation,
} from '../../../src/modules/azap/conversation/routeKind';
import {
  composeConversationalReply,
  resetNaturalReplyRotationForTests,
} from '../../../src/modules/azap/conversation/naturalReply';
import { resolvePronounRecipient } from '../../../src/modules/azap/conversation/dialogueContext';
import {
  parsePronounSend,
  parseUserMessage,
} from '../../../src/modules/four/engine/intentParser';
import {
  returningGreeting,
  resetGreetingRotationForTests,
  genericNudge,
} from '../../../src/modules/four/telegram/onboardingService';
import {
  confirmationPromptFromEntities,
} from '../../../src/modules/azap/modality/imageIngest';
import { ingestVoiceNote } from '../../../src/modules/azap/modality/voiceIngest';
import {
  findAssetNetwork,
  listEnabledAssets,
} from '../../../src/modules/azap/crypto/assetRegistry';

describe('azap 2.0 phase1 dialogue', () => {
  it('routes greetings and small talk as conversation', () => {
    expect(classifyRouteKind('Hi')).to.equal('conversation');
    expect(classifyRouteKind("I'm good, just got paid 😂")).to.equal(
      'conversation'
    );
    expect(classifyRouteKind('how far')).to.equal('conversation');
    expect(isPureGreeting('hey')).to.equal(true);
    expect(shouldPreferConversation('Love that')).to.equal(true);
  });

  it('routes money requests as action', () => {
    expect(classifyRouteKind('Send 20k to Tunde')).to.equal('action');
    expect(classifyRouteKind("What's my balance?")).to.equal('action');
    expect(classifyRouteKind('Buy airtime')).to.equal('action');
  });

  it('routes clarifications when money intent is active', () => {
    expect(
      classifyRouteKind('yes', { hasActiveMoneyIntent: true })
    ).to.equal('clarification');
    expect(
      classifyRouteKind('make it 30k', { hasActiveMoneyIntent: true })
    ).to.equal('clarification');
  });

  it('greeting copy is natural — not a /menu dump', () => {
    resetGreetingRotationForTests();
    const g = returningGreeting('Kola');
    expect(g.toLowerCase()).to.not.include('/menu');
    expect(g.toLowerCase()).to.match(/hey|yoo|hi|how/);
  });

  it('generic nudge is soft, not a bullet menu', () => {
    const n = genericNudge();
    expect(n).to.not.match(/^For example:\n•/);
  });

  it('composeConversationalReply returns safe fallback without inventing success', async () => {
    resetNaturalReplyRotationForTests();
    process.env.AZAP_LLM_PROVIDER = 'stub';
    const reply = await composeConversationalReply({
      userId: '00000000-0000-0000-0000-000000000001',
      conversationId: '00000000-0000-0000-0000-000000000002',
      text: "I'm good, just got paid 😂",
      firstName: 'Kola',
    });
    expect(reply.length).to.be.greaterThan(3);
    expect(reply.toLowerCase()).to.not.match(/sent successfully|i have sent/);
  });

  it('parses pronoun send amounts', () => {
    const p = parsePronounSend('Send him another 10k');
    expect(p?.amount).to.equal(10000);
    const parsed = parseUserMessage('Send her 5k');
    expect(parsed.kind).to.equal('send');
    if (parsed.kind === 'send') {
      expect(parsed.pronounRecipient).to.equal(true);
      expect(parsed.amount).to.equal(5000);
    }
  });

  it('resolves him/her from last money context', () => {
    expect(
      resolvePronounRecipient('send him another 10k', {
        recipientName: 'Tunde Adewale',
      })
    ).to.equal('Tunde Adewale');
    expect(resolvePronounRecipient('send him 10k', null)).to.equal(null);
  });

  it('image confirmation never implies auto-send', () => {
    const prompt = confirmationPromptFromEntities({
      kind: 'bank',
      bankName: 'GTBank',
      accountName: 'John Doe',
      accountNumber: '0123456789',
    });
    expect(prompt.toLowerCase()).to.include('how much');
    expect(prompt.toLowerCase()).to.not.include('sent');
  });

  it('voice ingest does not execute money (scaffold)', async () => {
    const r = await ingestVoiceNote({ userId: 'u1' });
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.userMessage.toLowerCase()).to.include('voice');
  });

  it('asset registry keeps USDC receive enabled; YC coins disabled until entitlement', () => {
    expect(listEnabledAssets('receiveEnabled').some((a) => a.symbol === 'USDC'))
      .to.equal(true);
    expect(findAssetNetwork('BTC', 'bitcoin')?.buyEnabled).to.equal(false);
  });
});
