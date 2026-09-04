import { expect } from 'chai';
import { describe, it } from 'mocha';
import { rankBanksForHint } from '../../src/modules/four/finance/recipientResolver';

describe('rankBanksForHint', () => {
  const banks = [
    { code: '058', name: 'Guaranty Trust Bank' },
    { code: '100004', name: 'Opay' },
    { code: '305', name: 'Paycom' },
    { code: '100033', name: 'PALMPAY' },
    { code: '090497', name: 'Palmcoast Microfinance Bank' },
  ];

  it('matches OPay to Opay before Paycom', () => {
    const ranked = rankBanksForHint(banks, 'OPay');
    expect(ranked.map((b) => b.code)).to.deep.equal(['100004', '305']);
  });

  it('matches Paycom via OPay alias', () => {
    const ranked = rankBanksForHint(
      [
        { code: '305', name: 'Paycom' },
        { code: '058', name: 'Guaranty Trust Bank' },
      ],
      'opay'
    );
    expect(ranked[0]?.code).to.equal('305');
  });

  it('does not match Palmcoast for OPay', () => {
    const ranked = rankBanksForHint(banks, 'OPay');
    expect(ranked.some((b) => b.code === '090497')).to.equal(false);
  });
});
