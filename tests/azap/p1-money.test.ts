import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  formatCryptoDepositExamples,
  formatCryptoFundingAsk,
  formatUnsupportedCrypto,
  parseCryptoDepositUtterance,
} from '../../src/modules/azap/capabilities/moneyCapabilities';
import { parseCryptoSendUtterance } from '../../src/modules/four/finance/cryptoSendFlow';
import { AZAP_MAX_ACTIONS } from '../../src/modules/azap/actionPlan/types';

describe('Azap P1 money parsing', () => {
  it('does not treat send USDC as a deposit', () => {
    const deposit = parseCryptoDepositUtterance(
      'Send 20 USDC to GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
    );
    expect(deposit.wantsCryptoFunding).to.equal(false);
    const send = parseCryptoSendUtterance(
      'Send 20 USDC to GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
    );
    expect(send?.asset).to.equal('USDC');
    expect(send?.to?.startsWith('G')).to.equal(true);
    expect(send?.network).to.equal('stellar');
  });

  it('parses EVM crypto send without applying NGN KYC in the parser', () => {
    const send = parseCryptoSendUtterance(
      'Send 20 USDC on Ethereum to 0x1234567890123456789012345678901234567890'
    );
    expect(send?.network).to.equal('ethereum');
    expect(send?.to?.startsWith('0x')).to.equal(true);
  });

  it('does not parse NGN send as crypto send', () => {
    expect(parseCryptoSendUtterance('Send 10k to OPay 8131208415')).to.equal(
      null
    );
  });

  it('builds short deposit examples (USDC Stellar + EURC Ethereum only)', () => {
    const examples = formatCryptoDepositExamples();
    expect(examples).to.equal(
      '• Deposit USDC on Stellar\n• Deposit EURC on Ethereum'
    );
    expect(examples.toLowerCase()).to.not.include('solana');
    expect(examples.toLowerCase()).to.not.include('base');
    const ask = formatCryptoFundingAsk('asset');
    expect(ask).to.include('Ready to deposit crypto');
    expect(ask).to.include(examples);
    // Keep the ask intentionally short — not an exhaustive network dump.
    expect(ask.toLowerCase()).to.not.include('arbitrum');
  });

  it('explains unsupported assets and networks from the registry', () => {
    const btc = formatUnsupportedCrypto({ asset: 'BTC' });
    expect(btc.toLowerCase()).to.include('stablecoin');
    expect(btc).to.include('USDC');
    expect(btc).to.include('EURC');

    const solana = formatUnsupportedCrypto({
      asset: 'USDC',
      network: 'Solana',
    });
    expect(solana).to.include("aren't currently available on Solana");
    expect(solana).to.include('Stellar');
    expect(solana).to.include('Ethereum');
  });

  it('caps ActionPlan at 4 actions', () => {
    expect(AZAP_MAX_ACTIONS).to.equal(4);
  });
});
