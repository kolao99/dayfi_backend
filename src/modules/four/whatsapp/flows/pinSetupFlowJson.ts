/**
 * Static WhatsApp Flow JSON for Azap PIN setup.
 * Opens as an in-WhatsApp bottom sheet (not Safari).
 *
 * No data endpoint — omit data_api_version so Meta treats this as static.
 * Completion returns pin + confirm_pin in nfm_reply.response_json.
 */
export const AZAP_PIN_SETUP_FLOW_NAME = 'azap_pin_setup_v1';

export const AZAP_PIN_SETUP_FLOW_JSON = {
  version: '6.3',
  routing_model: {
    ENTER_PIN: ['CONFIRM_PIN'],
    CONFIRM_PIN: [],
  },
  screens: [
    {
      id: 'ENTER_PIN',
      title: 'Create PIN',
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Create your 4-digit PIN',
          },
          {
            type: 'TextBody',
            text: 'Your PIN protects payments through Azap. It never appears in chat.',
          },
          {
            type: 'TextInput',
            name: 'pin',
            label: 'New PIN',
            'input-type': 'passcode',
            required: true,
            'helper-text': '4 digit transaction PIN',
            'min-chars': 4,
            'max-chars': 4,
            pattern: '^[0-9]{4}$',
          },
          {
            type: 'Footer',
            label: 'Continue',
            'on-click-action': {
              name: 'navigate',
              next: { type: 'screen', name: 'CONFIRM_PIN' },
              payload: {
                pin: '${form.pin}',
              },
            },
          },
        ],
      },
    },
    {
      id: 'CONFIRM_PIN',
      title: 'Confirm PIN',
      data: {
        // TextInput input-type=passcode yields a number in Flow JSON schema
        pin: {
          type: 'number',
          __example__: 1234,
        },
      },
      terminal: true,
      success: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Confirm your PIN',
          },
          {
            type: 'TextBody',
            text: 'Enter the same 4-digit PIN again to secure your wallet.',
          },
          {
            type: 'TextInput',
            name: 'confirm_pin',
            label: 'Confirm PIN',
            'input-type': 'passcode',
            required: true,
            'helper-text': '4 digit transaction PIN',
            'min-chars': 4,
            'max-chars': 4,
            pattern: '^[0-9]{4}$',
          },
          {
            type: 'Footer',
            label: 'Secure my wallet',
            'on-click-action': {
              name: 'complete',
              payload: {
                pin: '${data.pin}',
                confirm_pin: '${form.confirm_pin}',
              },
            },
          },
        ],
      },
    },
  ],
} as const;
