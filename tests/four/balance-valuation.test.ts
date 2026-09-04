import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  normalizeValuationCurrency,
  parseBalanceCurrencyHint,
} from '../../src/modules/four/finance/balanceService';

describe('four: balance valuation helpers', () => {
  it('normalizes currency aliases', () => {
    expect(normalizeValuationCurrency('naira')).to.equal('NGN');
    expect(normalizeValuationCurrency('cedis')).to.equal('GHS');
    expect(normalizeValuationCurrency('usdc')).to.equal('USD');
    expect(normalizeValuationCurrency('dollars')).to.equal('USD');
  });

  it('detects valuation hints without inventing a local wallet', () => {
    expect(parseBalanceCurrencyHint('How much do I have in naira?')).to.equal(
      'NGN'
    );
    expect(parseBalanceCurrencyHint('How much is that in cedis?')).to.equal(
      'GHS'
    );
    expect(parseBalanceCurrencyHint('Show my balance in NGN')).to.equal('NGN');
    expect(parseBalanceCurrencyHint('Send in naira')).to.equal(null);
    expect(parseBalanceCurrencyHint("What's my balance?")).to.equal(null);
  });
});
