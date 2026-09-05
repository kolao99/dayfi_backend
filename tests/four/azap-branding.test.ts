import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import {
  assistantName,
  fullBrandName,
  contactDisplayName,
} from '../../src/modules/four/brand';
import {
  welcomeMessage,
  walletCreatingMessage,
  walletReadyMessage,
  pinSecuredMessage,
  returningGreeting,
  resetGreetingRotationForTests,
  menuMessage,
  capabilitiesIntro,
} from '../../src/modules/four/telegram/onboardingService';

describe('azap branding', () => {
  const prevAzap = process.env.AZAP_ASSISTANT_NAME;
  const prevFour = process.env.FOUR_ASSISTANT_NAME;
  const prevFull = process.env.AZAP_FULL_BRAND_NAME;

  beforeEach(() => {
    delete process.env.AZAP_ASSISTANT_NAME;
    delete process.env.FOUR_ASSISTANT_NAME;
    delete process.env.AZAP_FULL_BRAND_NAME;
  });

  afterEach(() => {
    if (prevAzap === undefined) delete process.env.AZAP_ASSISTANT_NAME;
    else process.env.AZAP_ASSISTANT_NAME = prevAzap;
    if (prevFour === undefined) delete process.env.FOUR_ASSISTANT_NAME;
    else process.env.FOUR_ASSISTANT_NAME = prevFour;
    if (prevFull === undefined) delete process.env.AZAP_FULL_BRAND_NAME;
    else process.env.AZAP_FULL_BRAND_NAME = prevFull;
  });

  it('defaults to Azap / Azap by Dayfi', () => {
    expect(assistantName()).to.equal('Azap');
    expect(fullBrandName()).to.equal('Azap by Dayfi');
    expect(contactDisplayName()).to.equal('Azap by Dayfi');
  });

  it('migrates legacy MONY env to Azap', () => {
    process.env.FOUR_ASSISTANT_NAME = 'MONY';
    expect(assistantName()).to.equal('Azap');
  });

  it('user-facing copy never contains MONY or Four as product name', () => {
    const samples = [
      welcomeMessage('Kola', 'whatsapp'),
      walletReadyMessage(),
      pinSecuredMessage(),
      menuMessage(),
      capabilitiesIntro(),
    ];

    for (const text of samples) {
      expect(text).to.match(/\bAzap\b/);
      expect(text).to.not.match(/\bMONY\b/i);
      expect(text).to.not.match(/\bFour\b/);
      expect(text).to.not.match(/\bForth\b/i);
      expect(text).to.not.match(/\bAzza\b/i);
    }

    expect(welcomeMessage('Kola')).to.include('Azap by Dayfi');
  });

  it('acks immediately while creating a wallet', () => {
    const text = walletCreatingMessage();
    expect(text.toLowerCase()).to.include('creating your wallet');
    expect(text).to.not.match(/\bMONY\b/i);
  });

  it('soft greetings do not dump the transaction menu', () => {
    resetGreetingRotationForTests();
    for (let i = 0; i < 5; i++) {
      const text = returningGreeting('Kola');
      expect(text.toLowerCase()).to.match(/hey|hi|yoo|hello/);
      expect(text).to.not.include('Send ₦5,000 to Kola');
      expect(text).to.not.include('Fund my wallet');
      expect(text.toLowerCase()).to.include('menu');
    }
  });
});
