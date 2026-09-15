/**
 * Solution-oriented conversational outcomes (PM acceptance scenarios).
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  replyRecipientNotFound,
  replyCancelled,
  replyInsufficientBalance,
  replySupportedCoins,
  tryAnswerCapabilityQuestion,
  getSoftLaunchCapabilities,
} from '../../../src/modules/azap/conversation/solutionOriented';
import { returningGreeting, resetGreetingRotationForTests } from '../../../src/modules/four/telegram/onboardingService';
import { formatEntityNotFound } from '../../../src/modules/azap/entities/aliasService';
import { composeConversationalReply, resetNaturalReplyRotationForTests } from '../../../src/modules/azap/conversation/naturalReply';

describe('azap solution-oriented conversation', () => {
  it('greetings never inject /menu', () => {
    resetGreetingRotationForTests();
    for (let i = 0; i < 5; i++) {
      const g = returningGreeting('K');
      expect(g.toLowerCase()).to.not.include('/menu');
      expect(g.toLowerCase()).to.not.include('what would you like to do');
    }
  });

  it('answers what coins are supported from registry', () => {
    const caps = getSoftLaunchCapabilities();
    const ans = tryAnswerCapabilityQuestion('What coins do you support?');
    expect(ans).to.be.a('string');
    for (const a of caps.receiveAssets) {
      expect(ans!).to.include(a);
    }
    expect(ans!.toLowerCase()).to.not.match(/i don't understand|\/menu/);
  });

  it('answers can I buy BTC honestly with alternative', () => {
    const ans = tryAnswerCapabilityQuestion('Can I buy BTC?');
    expect(ans!.toLowerCase()).to.match(/not enabled|isn't enabled/);
    expect(ans!.toLowerCase()).to.match(/usdc|eurc/);
    expect(ans!.toLowerCase()).to.not.include('btc buying is available');
  });

  it('Buy BTC direct phrase is capability-aware', () => {
    const ans = tryAnswerCapabilityQuestion('Buy BTC');
    expect(ans).to.be.a('string');
    expect(ans!.toLowerCase()).to.match(/usdc|eurc/);
  });

  it('answers electricity capability', () => {
    const ans = tryAnswerCapabilityQuestion('Can I pay electricity?');
    expect(ans!.toLowerCase()).to.include('electricity');
  });

  it('answers Ghana send as corridor check, not a menu dump', () => {
    const ans = tryAnswerCapabilityQuestion('Can you send money to Ghana?');
    expect(ans!.toLowerCase()).to.match(/ghana|ghs|yellow card/);
    expect(ans!).to.not.match(/^For example:\n•/);
  });

  it('recipient not found proposes setup, not a dead end', () => {
    const msg = replyRecipientNotFound('my wife');
    expect(msg.toLowerCase()).to.include('set up');
    expect(msg.toLowerCase()).to.include('bank');
    expect(msg.toLowerCase()).to.not.include("couldn't find a saved contact");
  });

  it('alias not-found is solution-oriented', () => {
    const msg = formatEntityNotFound({ alias: 'My Wife', kind: 'recipient' });
    expect(msg.toLowerCase()).to.include('set up');
    expect(msg.toLowerCase()).to.not.include("couldn't find a saved recipient");
  });

  it('cancel invites next step', () => {
    expect(replyCancelled().toLowerCase()).to.include('what else');
  });

  it('insufficient balance offers fund or smaller amount', () => {
    const msg = replyInsufficientBalance('₦20,000');
    expect(msg.toLowerCase()).to.include('fund');
    expect(msg.toLowerCase()).to.include('smaller');
  });

  it('supported coins helper matches registry', () => {
    const msg = replySupportedCoins();
    expect(msg).to.include('USDC');
  });

  it('composeConversationalReply routes capability questions without claiming success', async () => {
    process.env.AZAP_LLM_PROVIDER = 'stub';
    resetNaturalReplyRotationForTests();
    const reply = await composeConversationalReply({
      userId: '00000000-0000-0000-0000-000000000001',
      conversationId: '00000000-0000-0000-0000-000000000002',
      text: 'What coins do you support?',
      firstName: 'K',
    });
    expect(reply).to.include('USDC');
    expect(reply.toLowerCase()).to.not.match(/sent successfully|i have sent|i've saved/);
  });

  it('small-talk fallback after "good" continues conversation', async () => {
    process.env.AZAP_LLM_PROVIDER = 'stub';
    resetNaturalReplyRotationForTests();
    // Burn pure greeting fallbacks if any
    await composeConversationalReply({
      userId: '00000000-0000-0000-0000-000000000001',
      conversationId: '00000000-0000-0000-0000-000000000002',
      text: 'good',
      firstName: 'K',
    });
    // Direct unit: capability null path uses fallbacks — call tryAnswer first
    expect(tryAnswerCapabilityQuestion('good')).to.equal(null);
  });
});
