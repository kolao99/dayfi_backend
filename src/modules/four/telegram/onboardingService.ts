import PaymentService from '../../payment/services';
import {
  getUserById,
  type FourUser,
} from '../auth/identityService';
import { assistantName, fullBrandName, contactDisplayName } from '../brand';
import { formatCryptoFundingAsk } from '../../azap/capabilities/moneyCapabilities';

const paymentService = new PaymentService();

export type OnboardingStage =
  | 'welcome'
  | 'wallet_ready'
  | 'pin_required'
  | 'intro_pending'
  | 'ready';

export type FourChannelLabel = 'telegram' | 'whatsapp';

export async function getOnboardingStage(
  userId: string,
  options?: { introShown?: boolean }
): Promise<OnboardingStage> {
  const user = await getUserById(userId);
  if (!user) return 'welcome';

  const wallet = await paymentService.getWalletByCurrency(userId, 'USD');
  if (!wallet) return 'welcome';

  if (!user.transaction_pin) return 'pin_required';

  if (!options?.introShown) return 'intro_pending';

  return 'ready';
}

export function displayName(user: FourUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || 'there';
}

export async function createUserWallet(userId: string): Promise<void> {
  await paymentService.ensureUserLedgerWallets(userId);
  // Activate Stellar with ~1.5 XLM + USDC/EURC trustlines, and provision EVM address.
  try {
    const { provisionCryptoWalletsForUser } = await import(
      '../../payment/cryptoWalletProvision'
    );
    await provisionCryptoWalletsForUser(userId);
  } catch (err) {
    console.warn(
      '[azap] crypto provision after create wallet failed',
      err instanceof Error ? err.message : err
    );
  }
}

export function isGreeting(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const brand = assistantName().toLowerCase();
  return (
    q === '/start' ||
    q === 'start' ||
    q === 'hey' ||
    q === 'hey four' ||
    q === 'hey mony' ||
    q === `hey ${brand}` ||
    q === 'hi' ||
    q === 'hello' ||
    q === 'hey man' ||
    q === 'yo' ||
    q === 'yoo' ||
    q.startsWith('hey ') ||
    q.startsWith('hi ')
  );
}

export function isMenuCommand(text: string): boolean {
  const q = text.toLowerCase().trim();
  return (
    q === '/' ||
    q === '/menu' ||
    q === 'menu' ||
    q === '/help' ||
    q === 'help'
  );
}

export type ChoiceButton = {
  id: string;
  label: string;
  userText?: string;
  disabled?: boolean;
};

export const ONBOARDING_BUTTONS = {
  createWallet: {
    id: 'create_wallet',
    label: 'Create wallet 🚀',
    userText: 'Create wallet',
  },
  setupPin: {
    id: 'setup_pin',
    label: 'Set up your PIN',
    userText: 'Set up your PIN for me',
  },
} as const;

export const CAPABILITY_BUTTONS: ChoiceButton[] = [
  {
    id: 'cap_send',
    label: '💸 Send money',
    userText: 'Send money',
  },
  {
    id: 'cap_fund',
    label: '💰 Fund wallet',
    userText: 'Fund my wallet',
  },
  {
    id: 'cap_balance',
    label: '💳 Check balance',
    userText: "What's my balance?",
  },
  {
    id: 'cap_airtime',
    label: '📱 Buy airtime',
    userText: 'Buy airtime',
  },
  {
    id: 'cap_bills',
    label: '🧾 Pay a bill',
    userText: 'Pay a bill',
  },
];

export const MENU_BUTTONS: ChoiceButton[] = [
  {
    id: 'menu_balance',
    label: '💳 Check balance',
    userText: "What's my balance?",
  },
  {
    id: 'menu_send',
    label: '💸 Send money',
    userText: 'Send money',
  },
  {
    id: 'menu_fund',
    label: '💰 Fund wallet',
    userText: 'Fund my wallet',
  },
  {
    id: 'menu_help',
    label: '❓ Help',
    userText: 'Help',
  },
];

export const FUND_BUTTONS: ChoiceButton[] = [
  {
    id: 'fund_crypto',
    label: '🪙 Fund with Crypto',
    userText: 'Fund with Crypto',
  },
  {
    id: 'fund_bank_ngn',
    label: '🏦 Bank transfer (NGN)',
    userText: 'Bank transfer (NGN)',
  },
];

export function fundWalletPromptMessage(): string {
  return 'How would you like to fund your wallet?';
}

export function insufficientBalanceMessage(amountFormatted: string): string {
  return (
    `You don't have enough balance to send ${amountFormatted}.\n\n` +
    'Fund your wallet first — choose an option below:'
  );
}

export function welcomeMessage(
  firstName: string,
  _channel: FourChannelLabel = 'telegram'
): string {
  const full = fullBrandName();
  const contact = contactDisplayName();
  return (
    `Hi ${firstName}! 👋 Welcome to ${full}.\n\n` +
    'Tap *Create wallet* to get started.\n' +
    `Save this contact as *${contact}*.`
  );
}

/** Immediate ack while ledger + crypto addresses are provisioned (can take several seconds). */
export function walletCreatingMessage(): string {
  return (
    "On it — creating your wallet now…\n" +
    "This usually takes a few seconds while we set up your balance and deposit addresses."
  );
}

export function walletReadyMessage(): string {
  const brand = assistantName();
  return (
    'Your wallet is ready! 🎉 Now let\'s secure it with a transaction PIN.\n' +
    'Tap "Set up your PIN" below — it opens a secure sheet inside WhatsApp.\n' +
    `Your PIN protects payments and transfers made through ${brand}. 🔒`
  );
}

export function pinSecuredMessage(): string {
  const brand = assistantName();
  return (
    'All set! 🎉 Your wallet is now secure. ' +
    `Keep your PIN private — it's your key to authorizing transactions with ${brand}. 🔒`
  );
}

const SOFT_GREETINGS: Array<(name: string) => string> = [
  (name) =>
    `Hey there${name ? `, ${name}` : ''}! 😊 I'm here to help with your money needs. Send /menu to see everything I can do for you!`,
  (name) =>
    `Hey${name ? ` ${name}` : ''}! 👋 What can I help you with today? Send /menu anytime to see what I can do.`,
  () =>
    `Yoo! 😄 I'm here. Need to send money, fund your wallet, buy airtime, pay a bill, or check your balance? Try /menu.`,
  (name) =>
    `Hey there${name ? ` ${name}` : ''} 👋 Good to see you! Just tell me what you need, or send /menu to explore.`,
  () =>
    `Hi! 😊 I'm Azap. Tell me what you need and I'll help you sort it out. You can also send /menu to see my options.`,
];

let _greetingIndex = 0;

/**
 * Soft returning greeting — does NOT dump the transaction menu.
 * Rotates through a few short, human variants.
 */
export function returningGreeting(firstName: string): string {
  const name = String(firstName || '').trim();
  const safe =
    name && !/^(there|friend|user)$/i.test(name) ? name.split(/\s+/)[0] : '';
  const fn = SOFT_GREETINGS[_greetingIndex % SOFT_GREETINGS.length];
  _greetingIndex = (_greetingIndex + 1) % SOFT_GREETINGS.length;
  return fn(safe);
}

/** Test helper — reset greeting rotation. */
export function resetGreetingRotationForTests(): void {
  _greetingIndex = 0;
}

export function menuMessage(): string {
  return `What can ${assistantName()} help with?`;
}

const CAPABILITIES_FULL = [
  '✅ Send & receive NGN (Nigeria bank)',
  '✅ Send & receive USDC & EURC',
  '✅ Fund your Dayfi wallet',
  '✅ Check your wallet balance (and naira/cedi equivalents)',
  '✅ Buy airtime & data',
  '✅ Pay electricity, internet & TV bills',
  '✅ See recent transactions',
].join('\n');

const CAPABILITIES_SHORT = [
  '✅ Send & receive NGN',
  '✅ Send & receive USDC & EURC',
  '✅ Fund your wallet',
  '✅ Check your balance',
  '✅ Airtime, data & bills',
].join('\n');

const CAPABILITIES_COMPACT = [
  '✅ Send & receive money (NGN + crypto)',
  '✅ Crypto deposits',
  '✅ Airtime & bills',
  '✅ Check your balance',
].join('\n');

function capabilitiesIntros(): string[] {
  const brand = assistantName();
  const full = fullBrandName();
  return [
    `*${full} — on WhatsApp* 💜\n\nHere's what I can help you with:\n\n${CAPABILITIES_FULL}\n\n*What would you like to do?*`,
    `*What can ${brand} help you with?* 💜\n\n${CAPABILITIES_SHORT}\n\n*What would you like to do?*`,
    `*${brand} is ready.* 💜\n\n${CAPABILITIES_COMPACT}\n\n*Choose an action below.*`,
    `*${full}* 💜\n\n${CAPABILITIES_FULL}\n\n*How can I help?*`,
    `Here's what ${brand} can do:\n\n${CAPABILITIES_SHORT}\n\n*What would you like to do?*`,
  ];
}

let _capabilitiesIndex = 0;

/**
 * Returns a short capabilities intro, rotating through 5 variants.
 * The rotation advances per call so consecutive users see variety,
 * but a single user interaction gets one consistent message.
 */
export function capabilitiesIntro(): string {
  const intros = capabilitiesIntros();
  const msg = intros[_capabilitiesIndex % intros.length];
  _capabilitiesIndex = (_capabilitiesIndex + 1) % intros.length;
  return msg;
}

/**
 * Transfer-prompt copy shown when user taps "Send money" or says they want to send.
 */
export function transferPrompt(): string {
  return (
    'Who are you sending to, and how much?\n\n' +
    '*For example:*\n' +
    '• Send ₦5,000 to Kola\n' +
    '• Send ₦2,000 to OPay 8012345678'
  );
}

/**
 * Fallback nudge for natural-language users who haven't stated a clear intent.
 */
export function genericNudge(): string {
  return (
    'For example:\n' +
    "• What's my balance?\n" +
    '• Send ₦20,000 to Kola\n' +
    '• Fund my wallet'
  );
}

export function airtimePrompt(): string {
  return (
    'Sure — I can top up airtime from your Dayfi wallet.\n\n' +
    'Tell me the amount and phone number.\n\n' +
    '*For example:*\n' +
    '• Buy ₦1,000 airtime for 08012345678'
  );
}

export function billPaymentPrompt(): string {
  return (
    'I can pay bills from your Dayfi wallet.\n\n' +
    'Which bill?\n' +
    '• Airtime\n' +
    '• Data\n' +
    '• Electricity\n' +
    '• Internet\n' +
    '• DSTV / GOtv'
  );
}

export function cryptoDepositPrompt(): string {
  return formatCryptoFundingAsk('asset');
}

export function cryptoDepositNoBvnPrompt(): string {
  return (
    formatCryptoFundingAsk('asset') +
    '\n\nCrypto deposits do not require BVN verification.'
  );
}

const BUTTON_SCOPES: Array<{ scope: string; buttons: ChoiceButton[] }> = [
  { scope: 'onboard', buttons: Object.values(ONBOARDING_BUTTONS) },
  { scope: 'capability', buttons: CAPABILITY_BUTTONS },
  { scope: 'menu', buttons: MENU_BUTTONS },
  { scope: 'fund', buttons: FUND_BUTTONS },
];

function normalizeButtonText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Match a tapped WhatsApp quick-reply button by developer payload id. */
export function matchButtonById(
  buttonId: string
): { scope: string; button: ChoiceButton } | null {
  const id = String(buttonId || '').trim();
  if (!id) return null;

  for (const group of BUTTON_SCOPES) {
    for (const button of group.buttons) {
      if (button.id === id) {
        return { scope: group.scope, button };
      }
    }
  }
  return null;
}

/** Match text the user sent by tapping a reply keyboard button (WhatsApp-style). */
export function matchButtonByUserText(
  text: string
): { scope: string; button: ChoiceButton } | null {
  const normalized = normalizeButtonText(text);
  if (!normalized) return null;

  for (const group of BUTTON_SCOPES) {
    for (const button of group.buttons) {
      const candidates = [
        button.label,
        button.userText,
        button.label.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\s]+/gu, '').trim(),
      ].filter(Boolean) as string[];

      if (candidates.some((c) => normalizeButtonText(c) === normalized)) {
        return { scope: group.scope, button };
      }
    }
  }
  return null;
}
