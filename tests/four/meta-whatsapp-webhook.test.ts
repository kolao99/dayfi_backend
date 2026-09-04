import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
  parseMetaInbound,
  verifyMetaWebhookSubscribe,
} from '../../src/modules/four/whatsapp/metaCloudProvider';

describe('four: meta whatsapp webhook', () => {
  it('verifies Meta subscribe handshake', () => {
    process.env.META_WHATSAPP_VERIFY_TOKEN = 'test-verify-token';

    const ok = verifyMetaWebhookSubscribe({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': '1234567890',
    });
    expect(ok.ok).to.equal(true);
    if (ok.ok) expect(ok.challenge).to.equal('1234567890');

    const bad = verifyMetaWebhookSubscribe({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '1234567890',
    });
    expect(bad.ok).to.equal(false);
  });

  it('parses inbound text messages from Meta webhook JSON', () => {
    const parsed = parseMetaInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1084162017872692',
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'Kola' }, wa_id: '2348131208415' }],
                messages: [
                  {
                    id: 'wamid.test',
                    from: '2348131208415',
                    type: 'text',
                    text: { body: 'Hey' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed).to.have.length(1);
    expect(parsed[0].fromPhoneE164).to.equal('+2348131208415');
    expect(parsed[0].body).to.equal('Hey');
    expect(parsed[0].profileName).to.equal('Kola');
  });

  it('parses WhatsApp Flow nfm_reply without exposing PIN as chat body', () => {
    const parsed = parseMetaInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'Kola' }, wa_id: '2348131208415' }],
                messages: [
                  {
                    id: 'wamid.flow',
                    from: '2348131208415',
                    type: 'interactive',
                    interactive: {
                      type: 'nfm_reply',
                      nfm_reply: {
                        name: 'flow',
                        body: 'Sent',
                        response_json: JSON.stringify({
                          flow_token: 'abc.def',
                          pin: '1234',
                          confirm_pin: '1234',
                        }),
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed).to.have.length(1);
    expect(parsed[0].body).to.equal('[flow_completed]');
    expect(parsed[0].flowReply?.flowToken).to.equal('abc.def');
    expect(parsed[0].flowReply?.response.pin).to.equal('1234');
    expect(parsed[0].flowReply?.response.confirm_pin).to.equal('1234');
  });
});
