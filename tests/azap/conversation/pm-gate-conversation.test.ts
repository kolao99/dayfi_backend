/**
 * PM gate — arbitrary WhatsApp-style conversation must stay intelligent & safe.
 * Stub LLM mode: grounded capability facts + no menu dumps / fake success.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { runConversationalBrain } from '../../../src/modules/azap/conversation/conversationalBrain';
import { tryAnswerCapabilityQuestion } from '../../../src/modules/azap/conversation/solutionOriented';
import {
  isResumeSendWithNewAmount,
  parseAmount,
  parsePronounSend,
} from '../../../src/modules/four/engine/intentParser';
import { replyRecipientNotFound } from '../../../src/modules/azap/conversation/solutionOriented';
import { returningGreeting, resetGreetingRotationForTests } from '../../../src/modules/four/telegram/onboardingService';

describe('azap PM gate — conversational intelligence', () => {
  before(() => {
    process.env.AZAP_LLM_PROVIDER = 'stub';
  });

  const uid = '00000000-0000-0000-0000-000000000011';
  const cid = '00000000-0000-0000-0000-000000000012';

  async function turn(text: string) {
    return runConversationalBrain({
      userId: uid,
      conversationId: cid,
      text,
      firstName: 'K',
    });
  }

  function assertSafeChat(reply: string) {
    const q = reply.toLowerCase();
    expect(q).to.not.include('/menu');
    expect(q).to.not.include('invalid request');
    expect(q).to.not.include('how can i help you today');
    expect(q).to.not.match(/i('ve| have) (just )?sent/);
    expect(q).to.not.match(/sent successfully/);
    expect(q).to.not.include('please select an option');
  }

  it('walks a long non-command conversation without menus or fake success', async () => {
    const script = [
      'Hey',
      "I'm good",
      'Just got paid 😂',
      "I don't even know what to do with the money",
      'What would you do?',
      'Actually never mind',
      'Wait',
      'Can I buy BTC?',
      "Why can't I?",
      'Okay what about USDC?',
      'Forget it',
      "I don't have her account number",
      "I'll get it later",
      'Thanks 😂',
    ];

    for (const line of script) {
      const r = await turn(line);
      expect(r.kind).to.equal('chat');
      if (r.kind === 'chat') assertSafeChat(r.reply);
    }
  });

  it('answers non-command product questions with grounded facts', () => {
    const qs = [
      'What coins do you support?',
      'Can I buy bitcoin?',
      "Why can't I buy bitcoin?",
      "What's USDC?",
      "What's the difference between USDC and USDT?",
      'Can I send money to Ghana?',
      'How does funding my wallet work?',
      'What can you actually do?',
      "I'm trying to save money.",
      'What would you do with 500k?',
    ];
    for (const q of qs) {
      const ans = tryAnswerCapabilityQuestion(q);
      expect(ans, q).to.be.a('string');
      assertSafeChat(ans!);
      if (/coins|btc|bitcoin|usdc/i.test(q)) {
        expect(ans!.toLowerCase()).to.match(/usdc|eurc|btc|fund|wallet|support/);
      }
    }
  });

  it('greetings stay human', () => {
    resetGreetingRotationForTests();
    for (let i = 0; i < 5; i++) {
      const g = returningGreeting('K');
      assertSafeChat(g);
      expect(g.toLowerCase()).to.match(/hey|yoo|hi|how/);
    }
  });

  it('recipient gap proposes setup', () => {
    const msg = replyRecipientNotFound('my wife');
    assertSafeChat(msg);
    expect(msg.toLowerCase()).to.include('bank');
  });

  it('resume-send and pronoun parsers support context continuations', () => {
    expect(isResumeSendWithNewAmount('Actually send 10k instead')).to.equal(
      true
    );
    expect(parseAmount('Actually send 10k instead')).to.equal(10000);
    expect(parsePronounSend('Send him another 5k')?.amount).to.equal(5000);
  });
});
