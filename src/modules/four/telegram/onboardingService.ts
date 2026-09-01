import PaymentService from '../../payment/services';
import {
  getUserById,
  type FourUser,
} from '../auth/identityService';
import {
  getLinkMetadata,
  updateLinkMetadata,
} from './telegramIdentityService';

const paymentService = new PaymentService();

export type OnboardingStage =
  | 'welcome'
  | 'wallet_ready'
  | 'pin_required'
  | 'intro_pending'
  | 'ready';

export async function getOnboardingStage(
  userId: string,
  telegramUserId: number | string
): Promise<OnboardingStage> {
  const user = await getUserById(userId);
  if (!user) return 'welcome';

  const wallet = await paymentService.getWalletByCurrency(userId, 'USD');
  if (!wallet) return 'welcome';

  if (!user.transaction_pin) return 'pin_required';

  const meta = await getLinkMetadata(telegramUserId);
  if (!meta.introShown) return 'intro_pending';

  return 'ready';
}

export function displayName(user: FourUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || 'there';
}

export async function markIntroShown(telegramUserId: number | string): Promise<void> {
  await updateLinkMetadata(telegramUserId, { introShown: true });
}

export async function createUserWallet(userId: string): Promise<void> {
  await paymentService.ensureUserLedgerWallets(userId);
}

export function isGreeting(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    q === '/start' ||
    q === 'start' ||
    q === 'hey' ||
    q === 'hey four' ||
    q === 'hi' ||
    q === 'hello' ||
    q.startsWith('hey ') ||
    q.startsWith('hi ')
  );
}

export function isMenuCommand(text: string): boolean {
  const q = text.toLowerCase().trim();
  return q === '/menu' || q === 'menu';
}

export type ChoiceButton = {
  id: string;
  label: string;
  disabled?: boolean;
};

export const ONBOARDING_BUTTONS = {
  createWallet: { id: 'create_wallet', label: '🚀 Create wallet' },
  setupPin: { id: 'setup_pin', label: '🔐 Set up Transaction PIN' },
} as const;

export const MENU_BUTTONS: ChoiceButton[] = [
  { id: 'menu_balance', label: '💳 Check balance' },
  { id: 'menu_send', label: '💸 Send money' },
  { id: 'menu_fund', label: '💰 Fund wallet' },
  { id: 'menu_help', label: '❓ Help' },
];

export const FUND_BUTTONS: ChoiceButton[] = [
  { id: 'fund_crypto', label: '🪙 Fund with Crypto' },
  { id: 'fund_bank_ngn', label: '🏦 Bank transfer (NGN)' },
];

export function capabilitiesIntro(): string {
  return (
    "Here's what I can do for you:\n\n" +
    '💸 **Send money** — Dayfi users, saved contacts, or local banks\n' +
    '💰 **Fund your wallet** — bank transfer or crypto\n' +
    '📱 **Airtime** — top up your phone\n' +
    '🧾 **Bills** — electricity and supported bills\n' +
    '💾 **Contacts** — save people and bill accounts with your own names\n\n' +
    'Just tell me what you want, or type /menu.'
  );
}

export function welcomeMessage(firstName: string): string {
  return (
    `Hi ${firstName}! 👋 Welcome to Four.\n\n` +
    'I can help you move, manage and use your money right here on Telegram.\n\n' +
    'You can send money, fund your wallet, pay bills, top up your phone and more.\n\n' +
    "**Let's get you set up.**"
  );
}

export function walletReadyMessage(): string {
  return (
    'Your wallet is ready! 🎉\n\n' +
    "Now let's secure it with a transaction PIN.\n\n" +
    'Your PIN protects payments and transfers made through Four. 🔒'
  );
}

export function pinSecuredMessage(): string {
  return (
    'All set! 🎉\n\n' +
    'Your wallet is now secure.\n\n' +
    "Keep your PIN private — it's your key to authorizing transactions with Four. 🔒"
  );
}

export function returningGreeting(firstName: string): string {
  return `Hey ${firstName}! 😄 What can I help you with?`;
}

export function menuMessage(): string {
  return 'What would you like to do?';
}
