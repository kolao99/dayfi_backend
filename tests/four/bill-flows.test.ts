import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  AZAP_BILL_FLOW_JSON_BY_CATEGORY,
  AZAP_BILL_FLOW_NAMES,
  billFlowCtaLabel,
  billFlowIntro,
} from '../../src/modules/four/whatsapp/flows/billFlowJson';
import {
  createWhatsappFlowToken,
  verifyWhatsappFlowToken,
} from '../../src/modules/four/whatsapp/flows/flowToken';

describe('azap bill flows', () => {
  it('defines Flow JSON for every consumer bill category', () => {
    const categories = Object.keys(AZAP_BILL_FLOW_NAMES);
    expect(categories).to.have.members([
      'AIRTIME',
      'MOBILEDATA',
      'UTILITYBILLS',
      'CABLEBILLS',
      'INTSERVICE',
    ]);
    for (const cat of categories) {
      const json = AZAP_BILL_FLOW_JSON_BY_CATEGORY[cat as keyof typeof AZAP_BILL_FLOW_JSON_BY_CATEGORY] as {
        screens: Array<{ id: string; terminal?: boolean }>;
      };
      expect(json.screens[0].id).to.equal('DETAILS');
      expect(json.screens[0].terminal).to.equal(true);
      expect(billFlowIntro(cat as any)).to.match(/Tap below/i);
      expect(billFlowCtaLabel(cat as any).length).to.be.greaterThan(3);
    }
  });

  it('signs bill flow tokens with category', () => {
    process.env.META_WHATSAPP_VERIFY_TOKEN =
      process.env.META_WHATSAPP_VERIFY_TOKEN || 'test-flow-secret';
    const token = createWhatsappFlowToken({
      userId: 'DAYFI-1',
      purpose: 'bill',
      category: 'AIRTIME',
    });
    const verified = verifyWhatsappFlowToken(token);
    expect(verified.ok).to.equal(true);
    if (verified.ok) {
      expect(verified.purpose).to.equal('bill');
      expect(verified.category).to.equal('AIRTIME');
      expect(verified.userId).to.equal('DAYFI-1');
    }
  });
});
