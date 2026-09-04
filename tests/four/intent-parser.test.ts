import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  isBalanceQuery,
  isKycRequest,
  parseAmount,
  parseDestinationPart,
  parseSendMessage,
  parseUserMessage,
} from '../../src/modules/four/engine/intentParser';

describe('four: intent parser', () => {
  it('detects balance queries', () => {
    expect(isBalanceQuery("What's my balance?")).to.equal(true);
    expect(isBalanceQuery('balance')).to.equal(true);
    expect(isBalanceQuery('send 5k to Kola')).to.equal(false);
  });

  it('detects KYC requests', () => {
    expect(isKycRequest('/kyc')).to.equal(true);
    expect(isKycRequest('I want to complete my KYC')).to.equal(true);
    expect(isKycRequest('Help me with KYC')).to.equal(true);
    expect(isKycRequest('How do I verify my BVN?')).to.equal(true);
    expect(isKycRequest('Send 5k to Kola')).to.equal(false);
  });

  it('detects bill and airtime requests', () => {
    expect(parseUserMessage('Can I pay a bill?').kind).to.equal('bill_prompt');
    expect(parseUserMessage('I want to pay my electricity').kind).to.equal(
      'bill_prompt'
    );
    expect(parseUserMessage('Buy airtime').kind).to.equal('airtime_prompt');
  });

  it('parses k amounts', () => {
    expect(parseAmount('20k')).to.equal(20000);
    expect(parseAmount('₦5k')).to.equal(5000);
    expect(parseAmount('15000')).to.equal(15000);
  });

  it('parses send messages to saved recipients', () => {
    const parsed = parseSendMessage('Send ₦20k to Kola');
    expect(parsed.amount).to.equal(20000);
    expect(parsed.recipientName).to.equal('Kola');
    expect(parsed.bankTarget).to.equal(undefined);
  });

  it('parses bank + account destinations', () => {
    for (const text of [
      'Send 2k to OPay 8131208415',
      'Send 2000 to OPay 8131208415',
      'Send ₦2,000 to OPay 8131208415',
      'Send 10k to OPay 8131208415',
    ]) {
      const parsed = parseUserMessage(text);
      expect(parsed.kind, text).to.equal('send');
      if (parsed.kind === 'send') {
        expect(parsed.recipientName, text).to.equal(null);
        expect(parsed.bankTarget, text).to.deep.equal({
          accountNumber: '8131208415',
          bankHint: 'OPay',
        });
      }
    }
  });

  it('parses account-only destinations without treating them as names', () => {
    const parsed = parseUserMessage('Send 2k to 8131208415');
    expect(parsed.kind).to.equal('send');
    if (parsed.kind === 'send') {
      expect(parsed.recipientName).to.equal(null);
      expect(parsed.bankTarget).to.deep.equal({
        accountNumber: '8131208415',
        bankHint: '',
      });
    }
  });

  it('parses incomplete NUBAN as bank target, not a contact nickname', () => {
    expect(parseDestinationPart('OPay 813120841')).to.deep.equal({
      recipientName: null,
      bankTarget: {
        accountNumber: '813120841',
        bankHint: 'OPay',
        incomplete: true,
      },
    });

    const send = parseUserMessage('Send 2k to OPay 813120841');
    expect(send.kind).to.equal('send');
    if (send.kind === 'send') {
      expect(send.amount).to.equal(2000);
      expect(send.recipientName).to.equal(null);
      expect(send.bankTarget).to.deep.equal({
        accountNumber: '813120841',
        bankHint: 'OPay',
        incomplete: true,
      });
    }
  });

  it('parses Send to OPay <account> without treating "to OPay" as a contact', () => {
    for (const text of [
      'Send to OPay 813120841',
      'Send to OPay 8131208415',
      'send to opay 8131277777',
    ]) {
      const parsed = parseUserMessage(text);
      expect(parsed.kind, text).to.equal('send');
      if (parsed.kind === 'send') {
        expect(parsed.recipientName, text).to.equal(null);
        expect(parsed.amount, text).to.equal(null);
        expect(parsed.bankTarget?.bankHint, text).to.match(/^opay$/i);
        expect(parsed.bankTarget?.accountNumber, text).to.match(/^\d{7,10}$/);
      }
    }

    const incomplete = parseUserMessage('Send to OPay 813120841');
    expect(incomplete.kind).to.equal('send');
    if (incomplete.kind === 'send') {
      expect(incomplete.bankTarget).to.deep.equal({
        accountNumber: '813120841',
        bankHint: 'OPay',
        incomplete: true,
      });
    }
  });

  it('still parses Send Kola 5k as name-then-amount', () => {
    const parsed = parseSendMessage('Send Kola 5k');
    expect(parsed.amount).to.equal(5000);
    expect(parsed.recipientName).to.equal('Kola');
    expect(parsed.bankTarget).to.equal(undefined);
  });

  it('parses destination follow-ups without treating them as amounts', () => {
    const dest = parseUserMessage('OPay 8131208415');
    expect(dest.kind).to.equal('destination_update');
    if (dest.kind === 'destination_update') {
      expect(dest.bankTarget).to.deep.equal({
        accountNumber: '8131208415',
        bankHint: 'OPay',
      });
    }
  });

  it('parses destination parts for bank transfers', () => {
    expect(parseDestinationPart('OPay 8131208415')).to.deep.equal({
      recipientName: null,
      bankTarget: { accountNumber: '8131208415', bankHint: 'OPay' },
    });
    expect(parseDestinationPart('Kola')).to.deep.equal({
      recipientName: 'Kola',
      bankTarget: null,
    });
  });

  it('parses amount updates', () => {
    const parsed = parseUserMessage('Make it 15k');
    expect(parsed.kind).to.equal('amount_update');
    if (parsed.kind === 'amount_update') {
      expect(parsed.amount).to.equal(15000);
    }

    const pivot = parseUserMessage('Actually make it 5k');
    expect(pivot.kind).to.equal('amount_update');
    if (pivot.kind === 'amount_update') {
      expect(pivot.amount).to.equal(5000);
    }
  });

  it('parses recipient corrections', () => {
    const parsed = parseUserMessage('Actually send it to Jane');
    expect(parsed.kind).to.equal('recipient_update');
    if (parsed.kind === 'recipient_update') {
      expect(parsed.recipientName).to.equal('Jane');
    }
  });

  it('recognizes send prompts without treating them as recipient names', () => {
    const parsed = parseUserMessage('I want to send money');
    expect(parsed.kind).to.equal('send_prompt');
  });

  it('maps /kyc to the KYC intent', () => {
    const parsed = parseUserMessage('/kyc');
    expect(parsed.kind).to.equal('kyc');
  });

  it('maps fund requests to the fund intent', () => {
    expect(parseUserMessage('Fund').kind).to.equal('fund');
    expect(parseUserMessage('fund wallet').kind).to.equal('fund');
    expect(parseUserMessage('How do I fund my wallet?').kind).to.equal('fund');
  });

  it('maps buy USDC / add naira to fund (ramp), not a CEX', () => {
    expect(parseUserMessage('Buy USDC').kind).to.equal('fund');
    expect(parseUserMessage('I want to buy crypto').kind).to.equal('fund');
    expect(parseUserMessage('Add ₦50000').kind).to.equal('fund');
  });

  it('maps sell USDC to send / off-ramp prompt', () => {
    expect(parseUserMessage('Sell USDC').kind).to.equal('send_prompt');
    expect(parseUserMessage('Cash out my USDC').kind).to.equal('send_prompt');
  });

  it('parses balance valuation in local currencies', () => {
    const ngn = parseUserMessage('How much do I have in naira?');
    expect(ngn.kind).to.equal('balance_in_currency');
    if (ngn.kind === 'balance_in_currency') expect(ngn.currency).to.equal('NGN');

    const ghs = parseUserMessage('Show my balance in cedis');
    expect(ghs.kind).to.equal('balance_in_currency');
    if (ghs.kind === 'balance_in_currency') expect(ghs.currency).to.equal('GHS');

    expect(parseUserMessage("What's my balance?").kind).to.equal('balance');
    expect(isBalanceQuery('How much do I have in naira?')).to.equal(false);
  });

  it('parses send cost quotes', () => {
    const q = parseUserMessage('How much USDC do I need to send ₦10000?');
    expect(q.kind).to.equal('send_cost_quote');
    if (q.kind === 'send_cost_quote') {
      expect(q.amount).to.equal(10000);
      expect(q.currency).to.equal('NGN');
    }

    const q2 = parseUserMessage('How much will ₦5000 cost me?');
    expect(q2.kind).to.equal('send_cost_quote');
    if (q2.kind === 'send_cost_quote') expect(q2.amount).to.equal(5000);
  });

  it('refuses true asset swap without advertising a dead endpoint', () => {
    expect(parseUserMessage('Convert my 100 USDC to EURC').kind).to.equal(
      'swap_unavailable'
    );
    expect(parseUserMessage('Swap USDC to EURC').kind).to.equal(
      'swap_unavailable'
    );
  });

  it('routes receive / bank / history / unsupported corridors', () => {
    expect(parseUserMessage('Give me my bank details').kind).to.equal(
      'bank_details'
    );
    expect(parseUserMessage('How can someone send me money?').kind).to.equal(
      'receive_help'
    );
    expect(parseUserMessage('show my transactions').kind).to.equal(
      'tx_history'
    );
    expect(parseUserMessage('did my transfer go through?').kind).to.equal(
      'tx_status'
    );
    const ghs = parseUserMessage('Send Kola GHS 500');
    expect(ghs.kind).to.equal('unsupported_corridor');
    if (ghs.kind === 'unsupported_corridor') {
      expect(ghs.currency).to.equal('GHS');
    }
  });
});
