import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  isBalanceQuery,
  parseAmount,
  parseSendMessage,
  parseUserMessage,
} from '../../src/modules/four/engine/intentParser';

describe('four: intent parser', () => {
  it('detects balance queries', () => {
    expect(isBalanceQuery("What's my balance?")).to.equal(true);
    expect(isBalanceQuery('balance')).to.equal(true);
    expect(isBalanceQuery('send 5k to Kola')).to.equal(false);
  });

  it('parses k amounts', () => {
    expect(parseAmount('20k')).to.equal(20000);
    expect(parseAmount('₦5k')).to.equal(5000);
    expect(parseAmount('15000')).to.equal(15000);
  });

  it('parses send messages', () => {
    const parsed = parseSendMessage('Send ₦20k to Kola');
    expect(parsed.amount).to.equal(20000);
    expect(parsed.recipientName).to.equal('Kola');
  });

  it('parses amount updates', () => {
    const parsed = parseUserMessage('Make it 15k');
    expect(parsed.kind).to.equal('amount_update');
    if (parsed.kind === 'amount_update') {
      expect(parsed.amount).to.equal(15000);
    }
  });
});
