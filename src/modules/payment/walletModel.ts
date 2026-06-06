/**
 * Global wallet: one USD ledger balance; USD/GBP/EUR/NGN are display / pay-with views.
 * @see docs/PAYMENTS_ARCHITECTURE.md
 */

import config from '../../config/env';
import { convertAmountBetween } from './fxService';

export const PRIMARY_CURRENCY = 'USD' as const;
export const LOCAL_SPEND_CURRENCY = 'NGN' as const;

/** Display order on home / add-money picker */
export const DISPLAY_CURRENCIES = ['USD', 'GBP', 'EUR', 'NGN'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export const WALLET_PROVIDER = {
  PLATFORM: 'platform',
  GREY: 'grey',
  YELLOWCARD: 'yellowcard',
  STELLAR: 'stellar',
  FLUTTERWAVE: 'flutterwave',
} as const;

export type WalletCurrency =
  | DisplayCurrency
  | 'CAD';

export type GreyKybStatus =
  | 'active'
  | 'pending'
  | 'processing'
  | 'request_bank_account';

/** Realistic Grey sandbox samples when KYB account numbers are not provisioned yet. */
const GREY_SANDBOX_DEMO: Record<
  string,
  {
    accountNumber?: string;
    iban?: string;
    bankName: string;
    routingNumber?: string;
  }
> = {
  USD: {
    accountNumber: '4848920173',
    routingNumber: '021000021',
    bankName: 'Column N.A.',
  },
  EUR: {
    iban: 'DE89370400440532013000',
    bankName: 'Grey EU',
  },
  GBP: {
    accountNumber: '31926819',
    routingNumber: '040004',
    bankName: 'Grey UK',
  },
};

function greySandboxDemoEnabled(): boolean {
  return (
    (config?.GREY_SANDBOX as boolean | undefined) ??
    process.env.DAYFI_GREY_SANDBOX !== 'false'
  );
}

export type WalletRow = {
  wallet_id: string;
  user_id: string;
  balance: number;
  currency: string;
  provider?: string;
  dayfi_id?: string | null;
  stellar_deposit_address?: string | null;
  ethereum_deposit_address?: string | null;
  account_number?: string | null;
  bank_name?: string | null;
  account_name?: string | null;
};

const WALLET_LABELS: Record<string, string> = {
  USD: 'United States Dollar',
  EUR: 'Euro',
  GBP: 'British Pound',
  NGN: 'Nigerian Naira',
};

export function formatMoney(amount: number, currency: string): string {
  const n = Number(amount);
  const code = currency.toUpperCase();
  const symbols: Record<string, string> = {
    USD: '$',
    GBP: '£',
    EUR: '€',
    NGN: '₦',
  };
  const sym = symbols[code] ?? '';
  return `${sym}${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function walletBalance(wallets: WalletRow[], currency: string): number {
  const row = wallets.find(
    (w) => String(w.currency).toUpperCase() === currency.toUpperCase()
  );
  return Number(row?.balance ?? 0);
}

/** USD ledger balance (single source of truth). */
export function usdLedgerBalance(wallets: WalletRow[]): number {
  return walletBalance(wallets, PRIMARY_CURRENCY);
}

/** Display rows — same global balance shown in each pay/display currency. */
export async function formatGlobalDisplayRows(
  usdBalance: number,
  wallets: WalletRow[] = []
) {
  const usdRow = wallets.find(
    (w) => String(w.currency).toUpperCase() === PRIMARY_CURRENCY
  );
  const ngnRow = wallets.find(
    (w) => String(w.currency).toUpperCase() === LOCAL_SPEND_CURRENCY
  );

  const rows = [];
  for (const currency of DISPLAY_CURRENCIES) {
    const { amount } = await convertAmountBetween(
      usdBalance,
      PRIMARY_CURRENCY,
      currency
    );
    rows.push({
      currency,
      name: WALLET_LABELS[currency] ?? currency,
      balance: amount,
      formattedBalance: formatMoney(amount, currency),
      walletId: usdRow?.wallet_id ?? null,
      displayOnly: true,
      accountNumber:
        currency === LOCAL_SPEND_CURRENCY
          ? ngnRow?.account_number ?? null
          : null,
      bankName:
        currency === LOCAL_SPEND_CURRENCY ? ngnRow?.bank_name ?? null : null,
      accountName:
        currency === LOCAL_SPEND_CURRENCY ? ngnRow?.account_name ?? null : null,
    });
  }
  return rows;
}

/** @deprecated Use [formatGlobalDisplayRows]. Kept for legacy callers. */
export function formatWalletBalanceRows(wallets: WalletRow[]) {
  const usd = usdLedgerBalance(wallets);
  return DISPLAY_CURRENCIES.map((currency) => ({
    currency,
    name: WALLET_LABELS[currency] ?? currency,
    balance: usd,
    formattedBalance: formatMoney(usd, PRIMARY_CURRENCY),
    walletId:
      wallets.find((w) => String(w.currency).toUpperCase() === PRIMARY_CURRENCY)
        ?.wallet_id ?? null,
    displayOnly: true,
    accountNumber: null,
    bankName: null,
  }));
}

/** Legacy shape — kept for older clients */
export function formatLedgerBalances(wallets: WalletRow[]) {
  const usd = wallets.find((w) => w.currency === PRIMARY_CURRENCY) ?? null;
  const ngn =
    wallets.find((w) => w.currency === LOCAL_SPEND_CURRENCY) ?? null;

  return {
    primary: {
      currency: PRIMARY_CURRENCY,
      balance: Number(usd?.balance ?? 0),
      walletId: usd?.wallet_id ?? null,
    },
    localSpend: {
      currency: LOCAL_SPEND_CURRENCY,
      balance: Number(ngn?.balance ?? 0),
      walletId: ngn?.wallet_id ?? null,
    },
    wallets,
  };
}

/**
 * Global wallet hub response — USD ledger total + display-currency views.
 */
export async function formatPrdWalletDetails(
  wallets: WalletRow[],
  totalUsdEquivalent?: number
) {
  const usdBalance =
    totalUsdEquivalent != null
      ? Number(totalUsdEquivalent)
      : usdLedgerBalance(wallets);
  const walletBalances = await formatGlobalDisplayRows(usdBalance, wallets);
  const ledger = formatLedgerBalances(wallets);

  return {
    globalWallet: {
      ledgerCurrency: PRIMARY_CURRENCY,
      balanceUsd: usdBalance,
    },
    totalAvailableBalance: {
      currency: PRIMARY_CURRENCY,
      amount: usdBalance,
      formatted: formatMoney(usdBalance, PRIMARY_CURRENCY),
    },
    walletBalances,
    balances: walletBalances.reduce(
      (acc, w) => {
        acc[w.currency] = w.balance;
        return acc;
      },
      {} as Record<string, number>
    ),
    ...ledger,
  };
}

function parseGreyMeta(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.raw_metadata;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** Map Grey VA row → mobile list item; balance from ledger when provided */
export function formatGreyAccountForUi(
  row: Record<string, unknown>,
  ledgerBalance?: number
): Record<string, unknown> {
  const currency = String(row.currency ?? 'USD').toUpperCase();
  const meta = parseGreyMeta(row);
  let accountNumber = row.account_number ?? null;
  let iban = row.iban ?? null;
  let bankName = row.bank_name ?? null;
  let routingNumber = row.routing_number ?? null;
  let isDemoAccount = false;

  const hasDepositDetails = Boolean(accountNumber || iban || routingNumber);

  let kybStatus = String(meta.kybStatus ?? 'pending') as GreyKybStatus;
  if (hasDepositDetails) {
    kybStatus = 'active';
  } else if (
    !hasDepositDetails &&
    currency !== 'NGN' &&
    greySandboxDemoEnabled()
  ) {
    const demo = GREY_SANDBOX_DEMO[currency];
    if (demo) {
      accountNumber = demo.accountNumber ?? accountNumber;
      iban = demo.iban ?? iban;
      bankName = demo.bankName;
      routingNumber = demo.routingNumber ?? routingNumber;
      kybStatus = 'active';
      isDemoAccount = true;
    }
  } else if (currency === 'NGN') {
    kybStatus = 'request_bank_account';
  } else if (currency === 'USD') {
    kybStatus = 'processing';
  } else {
    kybStatus = 'pending';
  }

  const statusMessage: Record<GreyKybStatus, string> = {
    active: 'Balance',
    pending: 'Balance',
    processing: 'Your bank account is processing...',
    request_bank_account: 'Request bank account',
  };

  const balance = ledgerBalance != null ? ledgerBalance : 0;

  const hasDisplayDetails = Boolean(accountNumber || iban);

  return {
    currency,
    name: WALLET_LABELS[currency] ?? currency,
    kybStatus,
    statusLabel: isDemoAccount
      ? 'Demo · Grey testnet'
      : statusMessage[kybStatus],
    balance,
    formattedBalance: formatMoney(balance, currency),
    canReceiveDeposits: hasDisplayDetails && !isDemoAccount && kybStatus === 'active',
    isDemoAccount,
    accountNumber,
    iban,
    bankName,
    routingNumber,
    rails: meta.rails ?? [],
    provider: currency === 'NGN' ? 'flutterwave' : 'grey',
    creditsTo: PRIMARY_CURRENCY,
  };
}

export function formatGreyAccountsList(
  rows: Record<string, unknown>[],
  wallets: WalletRow[] = []
): Record<string, unknown>[] {
  const order = ['USD', 'GBP', 'EUR', 'NGN'];
  const sorted = [...rows].sort(
    (a, b) =>
      order.indexOf(String(a.currency)) - order.indexOf(String(b.currency))
  );
  const globalUsd = usdLedgerBalance(wallets);
  return sorted.map((row) => formatGreyAccountForUi(row, globalUsd));
}
