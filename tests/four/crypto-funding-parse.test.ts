import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  isCryptoDepositSupported,
  parseCryptoDepositUtterance,
  getSupportedCryptoNetworks,
  getSupportedCryptoAssets,
} from '../../src/modules/azap/capabilities/moneyCapabilities';

describe('Azap money capability registry', () => {
  it('supports USDC on Stellar/Ethereum/BSC/Arbitrum for deposit', () => {
    expect(isCryptoDepositSupported('USDC', 'stellar')).to.equal(true);
    expect(isCryptoDepositSupported('USDC', 'ethereum')).to.equal(true);
    expect(isCryptoDepositSupported('USDC', 'bsc')).to.equal(true);
    expect(isCryptoDepositSupported('USDC', 'arbitrum')).to.equal(true);
    expect(isCryptoDepositSupported('USDC', 'mantle')).to.equal(false);
    expect(isCryptoDepositSupported('USDC', 'sonic')).to.equal(false);
    expect(isCryptoDepositSupported('USDC', 'xdc')).to.equal(false);
  });

  it('supports EURC on Stellar and Ethereum only', () => {
    expect(isCryptoDepositSupported('EURC', 'stellar')).to.equal(true);
    expect(isCryptoDepositSupported('EURC', 'ethereum')).to.equal(true);
    expect(isCryptoDepositSupported('EURC', 'bsc')).to.equal(false);
    expect(isCryptoDepositSupported('EURC', 'arbitrum')).to.equal(false);
  });

  it('does not treat Solana or Base as supported', () => {
    expect(isCryptoDepositSupported('USDC', 'solana')).to.equal(false);
    expect(getSupportedCryptoNetworks('USDC').map((n) => n.key)).to.not.include(
      'solana' as never
    );
  });

  it('parses USDC on stellar', () => {
    const p = parseCryptoDepositUtterance('USDC on stellar');
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal('stellar');
  });

  it('parses natural language deposit variants', () => {
    const put = parseCryptoDepositUtterance(
      'I want to put $50 USDC into my wallet on Stellar.'
    );
    expect(put.asset).to.equal('USDC');
    expect(put.network).to.equal('stellar');
    expect(put.amount).to.equal(50);
    expect(put.wantsCryptoFunding).to.equal(true);

    const compact = parseCryptoDepositUtterance('USDC Stellar 50');
    expect(compact.asset).to.equal('USDC');
    expect(compact.network).to.equal('stellar');
    expect(compact.amount).to.equal(50);
    expect(compact.wantsCryptoFunding).to.equal(true);

    const assetOnly = parseCryptoDepositUtterance('I want to deposit some USDC');
    expect(assetOnly.asset).to.equal('USDC');
    expect(assetOnly.network).to.equal(null);
    expect(assetOnly.wantsCryptoFunding).to.equal(true);
  });

  it('parses Deposit USDC on Stellar as funding continuation', () => {
    const p = parseCryptoDepositUtterance('Deposit USDC on Stellar');
    expect(p.wantsCryptoFunding).to.equal(true);
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal('stellar');
    expect(p.amount).to.equal(null);
  });

  it('parses amount + asset + network in one utterance', () => {
    const p = parseCryptoDepositUtterance(
      'I want to deposit 50 USDC on Stellar'
    );
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal('stellar');
    expect(p.amount).to.equal(50);
    expect(p.wantsCryptoFunding).to.equal(true);
  });

  it('parses Deposit 20 USDC on Stellar', () => {
    const p = parseCryptoDepositUtterance('Deposit 20 USDC on Stellar');
    expect(p.amount).to.equal(20);
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal('stellar');
  });

  it('parses deposit address questions', () => {
    const p = parseCryptoDepositUtterance("What's my USDC Stellar address?");
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal('stellar');
    expect(p.wantsDepositAddress).to.equal(true);
  });

  it('flags unknown networks like Solana', () => {
    const p = parseCryptoDepositUtterance('USDC on Solana');
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal(null);
    expect(p.unknownNetwork).to.equal('solana');
  });

  it('flags unsupported assets like BTC', () => {
    const p = parseCryptoDepositUtterance('Deposit BTC');
    expect(p.unknownAsset).to.equal('BTC');
    expect(p.wantsCryptoFunding).to.equal(true);
  });

  it('lists USDC and EURC as deposit assets', () => {
    expect(getSupportedCryptoAssets()).to.deep.equal(['USDC', 'EURC']);
  });

  it('does not mark plain USDC send as crypto funding', () => {
    const p = parseCryptoDepositUtterance('Send 20 USDC to this wallet');
    expect(p.wantsCryptoFunding).to.equal(false);
  });

  it('flags deposit status questions separately from funding', () => {
    const p = parseCryptoDepositUtterance('100 USDC received it yet?');
    expect(p.wantsDepositStatus).to.equal(true);
    expect(p.wantsCryptoFunding).to.equal(false);
    expect(p.asset).to.equal('USDC');
    expect(p.amount).to.equal(100);

    const arrived = parseCryptoDepositUtterance('Has my deposit arrived?');
    expect(arrived.wantsDepositStatus).to.equal(true);
    expect(arrived.wantsCryptoFunding).to.equal(false);
  });

  it('marks fund with USDC on Stellar as crypto funding', () => {
    const p = parseCryptoDepositUtterance('Fund my wallet with USDC on Stellar');
    expect(p.wantsCryptoFunding).to.equal(true);
    expect(p.asset).to.equal('USDC');
    expect(p.network).to.equal('stellar');
  });
});
