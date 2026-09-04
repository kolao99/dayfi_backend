/**
 * Bill payment conversational parsing + category detection (no provider calls).
 */
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  detectBillCategory,
  categoryLabel,
} from '../../../src/modules/four/finance/billPaymentFlow';
import {
  isBillRequest,
  isAirtimeRequest,
  parseUserMessage,
  parseAmount,
} from '../../../src/modules/four/engine/intentParser';
import { isDepositStatusQuestion } from '../../../src/modules/azap/capabilities/moneyCapabilities';

describe('azap bills: natural language', () => {
  it('detects bill categories from messy language', () => {
    expect(detectBillCategory('buy airtime')).to.equal('AIRTIME');
    expect(detectBillCategory('I wan recharge')).to.equal('AIRTIME');
    expect(detectBillCategory('put 2k data')).to.equal('MOBILEDATA');
    expect(detectBillCategory('pay my light')).to.equal('UTILITYBILLS');
    expect(detectBillCategory('pay nepa bill')).to.equal('UTILITYBILLS');
    expect(detectBillCategory('pay dstv')).to.equal('CABLEBILLS');
    expect(detectBillCategory('pay internet')).to.equal('INTSERVICE');
  });

  it('routes teen/Pidgin-style bill asks into bill_prompt', () => {
    expect(isBillRequest('Can I pay a bill?')).to.equal(true);
    expect(isBillRequest('pay my light')).to.equal(true);
    expect(isAirtimeRequest('buy airtime 1k')).to.equal(true);
    expect(parseUserMessage('abeg buy airtime').kind).to.equal(
      'airtime_prompt'
    );
    expect(parseUserMessage('buy airtime pls').kind).to.equal('airtime_prompt');
    expect(parseUserMessage('I need data').kind).to.equal('airtime_prompt');
    expect(parseUserMessage('pay my dstv').kind).to.equal('bill_prompt');
    expect(parseUserMessage('renew my cable').kind).to.equal('bill_prompt');
  });

  it('parses Nigerian amount styles', () => {
    expect(parseAmount('5k')).to.equal(5000);
    expect(parseAmount('₦1,000')).to.equal(1000);
    expect(parseAmount('N5000')).to.equal(5000);
    expect(parseAmount('2k')).to.equal(2000);
  });

  it('labels categories for users', () => {
    expect(categoryLabel('AIRTIME')).to.equal('Airtime');
    expect(categoryLabel('UTILITYBILLS')).to.equal('Electricity');
  });

  it('keeps deposit status questions distinct from bill language', () => {
    expect(isDepositStatusQuestion('has my usdc arrived?')).to.equal(true);
    expect(isDepositStatusQuestion('pay electricity')).to.equal(false);
  });
});
