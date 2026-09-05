/**
 * Static WhatsApp Flow JSON for Azap bill categories (Azza-style bottom sheets).
 * Completion payloads feed the same BillsService path as conversational bills.
 *
 * Dynamic FLW catalogues (bundles/packages) are resolved server-side after
 * nfm_reply — Flow collects the structured fields; Azap resolves billers/items.
 */
import type { BillCategoryCode } from '../../finance/billPaymentFlow';

const NETWORK_OPTIONS = [
  { id: 'MTN', title: 'MTN' },
  { id: 'Airtel', title: 'Airtel' },
  { id: 'Glo', title: 'Glo' },
  { id: '9mobile', title: '9mobile' },
];

const DISCO_OPTIONS = [
  { id: 'IKEDC', title: 'IKEDC' },
  { id: 'EKEDC', title: 'EKEDC' },
  { id: 'AEDC', title: 'AEDC' },
  { id: 'PHED', title: 'PHED' },
  { id: 'IBEDC', title: 'IBEDC' },
  { id: 'KEDCO', title: 'KEDCO' },
];

const TV_OPTIONS = [
  { id: 'DSTV', title: 'DSTV' },
  { id: 'GOtv', title: 'GOtv' },
  { id: 'Startimes', title: 'Startimes' },
];

const INTERNET_OPTIONS = [
  { id: 'Spectranet', title: 'Spectranet' },
  { id: 'Smile', title: 'Smile' },
  { id: 'Other', title: 'Other / ISP' },
];

function radioGroup(
  name: string,
  label: string,
  options: Array<{ id: string; title: string }>,
  required = true
) {
  return {
    type: 'RadioButtonsGroup',
    name,
    label,
    required,
    'data-source': options.map((o) => ({ id: o.id, title: o.title })),
  };
}

export const AZAP_BILL_FLOW_NAMES: Record<BillCategoryCode, string> = {
  AIRTIME: 'azap_bill_airtime_v1',
  MOBILEDATA: 'azap_bill_data_v1',
  UTILITYBILLS: 'azap_bill_electricity_v1',
  CABLEBILLS: 'azap_bill_tv_v1',
  INTSERVICE: 'azap_bill_internet_v1',
};

export const AZAP_BILL_AIRTIME_FLOW_JSON = {
  version: '6.3',
  routing_model: {
    DETAILS: [],
  },
  screens: [
    {
      id: 'DETAILS',
      title: 'Buy Airtime',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Buy airtime',
          },
          {
            type: 'TextBody',
            text: 'Choose a network, enter the phone number, and amount in naira.',
          },
          radioGroup('network', 'Network', NETWORK_OPTIONS),
          {
            type: 'TextInput',
            name: 'phone',
            label: 'Phone Number',
            'input-type': 'phone',
            required: true,
            'helper-text': 'Enter your phone number.',
          },
          {
            type: 'TextInput',
            name: 'amount',
            label: 'Amount (In Naira)',
            'input-type': 'number',
            required: true,
            'helper-text': 'Enter amount.',
          },
          {
            type: 'Footer',
            label: 'Continue',
            'on-click-action': {
              name: 'complete',
              payload: {
                network: '${form.network}',
                phone: '${form.phone}',
                amount: '${form.amount}',
                category: 'AIRTIME',
              },
            },
          },
        ],
      },
    },
  ],
} as const;

export const AZAP_BILL_DATA_FLOW_JSON = {
  version: '6.3',
  routing_model: {
    DETAILS: [],
  },
  screens: [
    {
      id: 'DETAILS',
      title: 'Buy Data',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Buy data',
          },
          {
            type: 'TextBody',
            text: 'Choose a network and phone. We will match available data bundles next.',
          },
          radioGroup('network', 'Network', NETWORK_OPTIONS),
          {
            type: 'TextInput',
            name: 'phone',
            label: 'Phone Number',
            'input-type': 'phone',
            required: true,
            'helper-text': 'Enter your phone number.',
          },
          {
            type: 'TextInput',
            name: 'amount',
            label: 'Approx. amount (₦)',
            'input-type': 'number',
            required: true,
            'helper-text': 'We will pick the closest supported bundle.',
          },
          {
            type: 'Footer',
            label: 'Continue',
            'on-click-action': {
              name: 'complete',
              payload: {
                network: '${form.network}',
                phone: '${form.phone}',
                amount: '${form.amount}',
                category: 'MOBILEDATA',
              },
            },
          },
        ],
      },
    },
  ],
} as const;

export const AZAP_BILL_ELECTRICITY_FLOW_JSON = {
  version: '6.3',
  routing_model: {
    DETAILS: [],
  },
  screens: [
    {
      id: 'DETAILS',
      title: 'Buy Electricity',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Buy electricity',
          },
          radioGroup('disco', 'Electricity provider', DISCO_OPTIONS),
          radioGroup('meter_type', 'Meter type', [
            { id: 'prepaid', title: 'Prepaid' },
            { id: 'postpaid', title: 'Postpaid' },
          ]),
          {
            type: 'TextInput',
            name: 'meter',
            label: 'Meter number',
            required: true,
            'helper-text': 'Enter your meter / customer number.',
          },
          {
            type: 'TextInput',
            name: 'amount',
            label: 'Amount (In Naira)',
            'input-type': 'number',
            required: true,
          },
          {
            type: 'Footer',
            label: 'Continue',
            'on-click-action': {
              name: 'complete',
              payload: {
                disco: '${form.disco}',
                meter_type: '${form.meter_type}',
                meter: '${form.meter}',
                amount: '${form.amount}',
                category: 'UTILITYBILLS',
              },
            },
          },
        ],
      },
    },
  ],
} as const;

export const AZAP_BILL_TV_FLOW_JSON = {
  version: '6.3',
  routing_model: {
    DETAILS: [],
  },
  screens: [
    {
      id: 'DETAILS',
      title: 'Pay TV',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Pay DSTV / GOtv',
          },
          radioGroup('provider', 'Provider', TV_OPTIONS),
          {
            type: 'TextInput',
            name: 'smartcard',
            label: 'Smartcard / IUC number',
            required: true,
            'helper-text': 'Enter your decoder / IUC number.',
          },
          {
            type: 'TextInput',
            name: 'amount',
            label: 'Amount (In Naira)',
            'input-type': 'number',
            required: true,
          },
          {
            type: 'Footer',
            label: 'Continue',
            'on-click-action': {
              name: 'complete',
              payload: {
                provider: '${form.provider}',
                smartcard: '${form.smartcard}',
                amount: '${form.amount}',
                category: 'CABLEBILLS',
              },
            },
          },
        ],
      },
    },
  ],
} as const;

export const AZAP_BILL_INTERNET_FLOW_JSON = {
  version: '6.3',
  routing_model: {
    DETAILS: [],
  },
  screens: [
    {
      id: 'DETAILS',
      title: 'Pay Internet',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextHeading',
            text: 'Pay internet',
          },
          radioGroup('provider', 'Provider', INTERNET_OPTIONS),
          {
            type: 'TextInput',
            name: 'account',
            label: 'Account / customer number',
            required: true,
          },
          {
            type: 'TextInput',
            name: 'amount',
            label: 'Amount (In Naira)',
            'input-type': 'number',
            required: true,
          },
          {
            type: 'Footer',
            label: 'Continue',
            'on-click-action': {
              name: 'complete',
              payload: {
                provider: '${form.provider}',
                account: '${form.account}',
                amount: '${form.amount}',
                category: 'INTSERVICE',
              },
            },
          },
        ],
      },
    },
  ],
} as const;

export const AZAP_BILL_FLOW_JSON_BY_CATEGORY: Record<
  BillCategoryCode,
  unknown
> = {
  AIRTIME: AZAP_BILL_AIRTIME_FLOW_JSON,
  MOBILEDATA: AZAP_BILL_DATA_FLOW_JSON,
  UTILITYBILLS: AZAP_BILL_ELECTRICITY_FLOW_JSON,
  CABLEBILLS: AZAP_BILL_TV_FLOW_JSON,
  INTSERVICE: AZAP_BILL_INTERNET_FLOW_JSON,
};

export function billFlowCtaLabel(category: BillCategoryCode): string {
  switch (category) {
    case 'AIRTIME':
      return 'Buy Airtime';
    case 'MOBILEDATA':
      return 'Buy Data';
    case 'UTILITYBILLS':
      return 'Pay Electricity';
    case 'CABLEBILLS':
      return 'Pay TV';
    case 'INTSERVICE':
      return 'Pay Internet';
    default:
      return 'Continue';
  }
}

export function billFlowIntro(category: BillCategoryCode): string {
  switch (category) {
    case 'AIRTIME':
      return 'Sure 😊 Tap below to buy airtime.';
    case 'MOBILEDATA':
      return 'Sure 😊 Tap below to buy data.';
    case 'UTILITYBILLS':
      return 'Sure 😊 Tap below to pay electricity.';
    case 'CABLEBILLS':
      return 'Sure 😊 Tap below to pay DSTV / GOtv.';
    case 'INTSERVICE':
      return 'Sure 😊 Tap below to pay internet.';
    default:
      return 'Sure 😊 Tap below to continue.';
  }
}
