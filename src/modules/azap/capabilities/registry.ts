/**
 * Azap Capability Registry — single source of truth for slash menu, /help,
 * and future LLM tool descriptions.
 *
 * Commands are shortcuts into the same capabilities as natural language.
 */

export type AzapCapabilityCategory =
  | 'wallet'
  | 'money'
  | 'crypto'
  | 'bills'
  | 'account'
  | 'help'
  | 'commercial';

export type AzapCapability = {
  id: string;
  name: string;
  description: string;
  command: string;
  category: AzapCapabilityCategory;
  enabled: boolean;
  requiresAuth: boolean;
  requiresKyc: boolean;
  requiresPin: boolean;
  conversationalExamples: string[];
  /** Existing handler id in four engine / future tool name */
  handler: string;
};

export const AZAP_CAPABILITIES: readonly AzapCapability[] = [
  {
    id: 'balance_check',
    name: 'Check balance',
    description: 'See how much you have in your Azap wallet',
    command: '/balance',
    category: 'wallet',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: [
      "What's my balance?",
      'How much do I have?',
      'How much USDC do I have?',
    ],
    handler: 'get_balance',
  },
  {
    id: 'my_assets',
    name: 'My assets',
    description: 'List assets in your wallet',
    command: '/my_assets',
    category: 'wallet',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Show my assets', 'What do I hold?'],
    handler: 'get_assets',
  },
  {
    id: 'deposit',
    name: 'Deposit / fund',
    description: 'Fund your wallet with crypto or bank transfer',
    command: '/deposit',
    category: 'wallet',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: [
      'Fund my wallet',
      'I want to deposit USDC',
      'How do I add money?',
    ],
    handler: 'fiat_funding',
  },
  {
    id: 'withdraw',
    name: 'Withdraw',
    description: 'Withdraw from your Azap wallet',
    command: '/withdraw',
    category: 'wallet',
    enabled: true,
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    conversationalExamples: ['Withdraw to my bank', 'Cash out'],
    handler: 'fiat_withdrawal',
  },
  {
    id: 'crypto_buy',
    name: 'Fund USDC (fiat or crypto)',
    description:
      'Fund your USDC wallet via NGN bank transfer or crypto deposit — not a CEX buy',
    command: '/buy',
    category: 'crypto',
    enabled: true,
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    conversationalExamples: [
      'Buy USDC',
      'Fund my wallet with ₦50,000',
      'Add money',
    ],
    handler: 'crypto_buy',
  },
  {
    id: 'crypto_sell',
    name: 'Cash out USDC',
    description:
      'Withdraw USDC value as NGN (or other supported payout) — off-ramp / send',
    command: '/sell',
    category: 'crypto',
    enabled: true,
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    conversationalExamples: ['Sell USDC', 'Cash out to my bank'],
    handler: 'crypto_sell',
  },
  {
    id: 'crypto_swap',
    name: 'Swap',
    description:
      'Asset-to-asset conversion (USDC↔EURC) — unavailable; ask for NGN/GHS valuation instead',
    command: '/swap',
    category: 'crypto',
    enabled: false,
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    conversationalExamples: ['Swap USDC to EURC'],
    handler: 'crypto_swap',
  },
  {
    id: 'bank_transfer',
    name: 'Send money',
    description: 'Send money from your Azap wallet to a bank account',
    command: '/pay',
    category: 'money',
    enabled: true,
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    conversationalExamples: [
      'Send 2k to Kola',
      'Send ₦2,000 to OPay 8012345678',
    ],
    handler: 'bank_transfer',
  },
  {
    id: 'send_alias',
    name: 'Send',
    description: 'Alias for send money',
    command: '/send',
    category: 'money',
    enabled: true,
    requiresAuth: true,
    requiresKyc: true,
    requiresPin: true,
    conversationalExamples: ['Send money to Jane'],
    handler: 'bank_transfer',
  },
  {
    id: 'fund',
    name: 'Fund wallet',
    description: 'Fund your Azap wallet',
    command: '/fund',
    category: 'money',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Fund my wallet'],
    handler: 'fiat_funding',
  },
  {
    id: 'rates',
    name: 'Rates',
    description: 'Check FX / corridor rates',
    command: '/rates',
    category: 'money',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['What are the rates?', 'USD to NGN rate'],
    handler: 'get_rates',
  },
  {
    id: 'airtime',
    name: 'Airtime',
    description: 'Top up airtime',
    command: '/airtime',
    category: 'bills',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    conversationalExamples: ['Top up my phone with 500', 'Buy airtime'],
    handler: 'airtime_purchase',
  },
  {
    id: 'data',
    name: 'Data',
    description: 'Buy mobile data',
    command: '/data',
    category: 'bills',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    conversationalExamples: ['Buy data for my phone'],
    handler: 'data_purchase',
  },
  {
    id: 'bills',
    name: 'Pay bills',
    description: 'Pay electricity and other supported bills',
    command: '/bills',
    category: 'bills',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    conversationalExamples: [
      'Pay my electricity',
      'Pay home electricity',
    ],
    handler: 'bill_payment',
  },
  {
    id: 'verify_me',
    name: 'Verify me',
    description: 'Start or continue KYC verification',
    command: '/verify_me',
    category: 'account',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Verify me', 'I want to complete KYC'],
    handler: 'kyc',
  },
  {
    id: 'kyc',
    name: 'KYC',
    description: 'Identity verification',
    command: '/kyc',
    category: 'account',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['/kyc'],
    handler: 'kyc',
  },
  {
    id: 'change_pin',
    name: 'Change PIN',
    description: 'Change your transaction PIN',
    command: '/change_pin',
    category: 'account',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    conversationalExamples: ['Change my PIN'],
    handler: 'change_pin',
  },
  {
    id: 'reset_pin',
    name: 'Reset PIN',
    description: 'Reset your transaction PIN',
    command: '/reset_pin',
    category: 'account',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Reset my PIN'],
    handler: 'reset_pin',
  },
  {
    id: 'statement',
    name: 'Statement',
    description: 'Generate an account statement',
    command: '/statement',
    category: 'account',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Send me my statement'],
    handler: 'statement_request',
  },
  {
    id: 'help',
    name: 'Help',
    description: 'What Azap can do',
    command: '/help',
    category: 'help',
    enabled: true,
    requiresAuth: false,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Help', 'What can you do?'],
    handler: 'help',
  },
  {
    id: 'support',
    name: 'Support',
    description: 'Talk to the Azap team',
    command: '/support',
    category: 'help',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['I need support', 'Talk to a human'],
    handler: 'support',
  },
  {
    id: 'charges',
    name: 'Charges',
    description: 'View Azap pricing',
    command: '/charges',
    category: 'commercial',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: [
      'Azap Charges',
      'How much does a transfer cost?',
    ],
    handler: 'pricing_request',
  },
  {
    id: 'billing_consent',
    name: 'Billing consent',
    description: 'Review billing consent',
    command: '/billing_consent',
    category: 'commercial',
    enabled: true,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: true,
    conversationalExamples: ['Billing Consent', 'Review consent'],
    handler: 'consent_review',
  },
  {
    id: 'referral',
    name: 'Referral',
    description: 'Referral program',
    command: '/referral',
    category: 'commercial',
    enabled: false,
    requiresAuth: true,
    requiresKyc: false,
    requiresPin: false,
    conversationalExamples: ['Referral code'],
    handler: 'referral',
  },
] as const;

const CATEGORY_LABEL: Record<AzapCapabilityCategory, string> = {
  wallet: '👛 Wallet',
  money: '💰 Money',
  crypto: '🪙 Crypto',
  bills: '💡 Bills',
  account: '🔐 Account',
  help: '💬 Help',
  commercial: '📄 Commercial',
};

export function listEnabledCapabilities(): AzapCapability[] {
  return AZAP_CAPABILITIES.filter((c) => c.enabled);
}

export function findCapabilityByCommand(
  text: string
): AzapCapability | null {
  const q = String(text || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
  if (!q.startsWith('/')) return null;
  return (
    listEnabledCapabilities().find((c) => c.command.toLowerCase() === q) ??
    null
  );
}

export function isSlashDiscovery(text: string): boolean {
  const q = String(text || '').trim();
  return q === '/' || q === '/menu' || q.toLowerCase() === 'menu';
}

export function formatCapabilityMenu(): string {
  const byCat = new Map<AzapCapabilityCategory, AzapCapability[]>();
  for (const cap of listEnabledCapabilities()) {
    if (cap.id === 'send_alias') continue; // keep /pay as primary in menu
    const list = byCat.get(cap.category) ?? [];
    list.push(cap);
    byCat.set(cap.category, list);
  }

  const order: AzapCapabilityCategory[] = [
    'money',
    'wallet',
    'crypto',
    'bills',
    'account',
    'commercial',
    'help',
  ];

  const lines: string[] = [
    'What can Azap do for you?',
    '',
    'Type a command, or just tell me in plain English.',
    '',
  ];

  for (const cat of order) {
    const caps = byCat.get(cat);
    if (!caps?.length) continue;
    lines.push(CATEGORY_LABEL[cat]);
    for (const c of caps) {
      lines.push(`${c.command} — ${c.description}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatHelpMessage(): string {
  return (
    `Here's what I can help you with:\n\n` +
    `💰 Money\nSend money, fund your wallet and withdraw.\n\n` +
    `🪙 Crypto\nDeposit USDC, send crypto, fund via fiat, or cash out as NGN.\n\n` +
    `📱 Airtime & Data\nTop up your phone and buy data.\n\n` +
    `💡 Bills\nPay electricity and other supported bills.\n\n` +
    `👛 Wallet\nCheck balances, assets and transactions.\n\n` +
    `🔐 Account\nKYC, PIN and security.\n\n` +
    `📄 Statements\nGenerate account statements.\n\n` +
    `💬 Support\nGet help from the Azap team.\n\n` +
    `Type / to explore commands.`
  );
}
