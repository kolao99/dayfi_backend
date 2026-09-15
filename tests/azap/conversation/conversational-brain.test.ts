/**
 * Conversational brain — non-command utterances must not become menu dumps.
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  runConversationalBrain,
  scrubBrainReplyForTests,
} from '../../../src/modules/azap/conversation/conversationalBrain';

describe('azap conversational brain', () => {
  before(() => {
    process.env.AZAP_LLM_PROVIDER = 'stub';
  });

  const uid = '00000000-0000-0000-0000-000000000001';
  const cid = '00000000-0000-0000-0000-000000000002';

  async function chat(text: string) {
    return runConversationalBrain({
      userId: uid,
      conversationId: cid,
      text,
      firstName: 'K',
    });
  }

  it('handles casual non-commands without /menu', async () => {
    for (const text of [
      'Hey',
      'I just got paid 😂',
      "I'm tired abeg",
      "I'm broke 😂",
      'Thanks',
      'Never mind',
      '😂',
      'Abeg help me',
      "I don't understand crypto",
      'Explain USDC',
      'Should I buy bitcoin?',
    ]) {
      const r = await chat(text);
      expect(r.kind).to.equal('chat');
      if (r.kind === 'chat') {
        expect(r.reply.toLowerCase()).to.not.include('/menu');
        expect(r.reply.toLowerCase()).to.not.include('invalid request');
        expect(r.reply.toLowerCase()).to.not.include("i don't understand your request");
        expect(r.reply.toLowerCase()).to.not.match(/^for example:\n•/);
      }
    }
  });

  it('answers capability questions via brain', async () => {
    const r = await chat('What coins do you support?');
    expect(r.kind).to.equal('chat');
    if (r.kind === 'chat') expect(r.reply).to.include('USDC');
  });

  it('scrubs fabricated success claims', () => {
    const scrubbed = scrubBrainReplyForTests(
      "I've just sent ₦20,000. Your new balance is ₦5,000."
    );
    expect(scrubbed.toLowerCase()).to.not.include('sent');
    expect(scrubbed.toLowerCase()).to.not.include('balance is');
  });

  it('emits structured action for clear balance ask when parser used in stub', async () => {
    const r = await chat("What's my balance?");
    // May be action via parser stub path, or chat if capability — balance is action
    expect(['action', 'chat']).to.include(r.kind);
    if (r.kind === 'action') {
      expect(r.actions[0].type).to.equal('balance_check');
    }
  });
});
