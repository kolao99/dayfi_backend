/**
 * PRD V1: four visible wallets (USD, GBP, EUR, NGN) + total in USD equivalent.
 * @see docs/PAYMENTS_ARCHITECTURE.md
 */

import config from '../../config/env';

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

/** Per-currency row for mobile home + add-money */
export function formatWalletBalanceRows(wallets: WalletRow[]) {
  return DISPLAY_CURRENCIES.map((currency) => {
    const balance = walletBalance(wallets, currency);
    const row = wallets.find(
      (w) => String(w.currency).toUpperCase() === currency
    );
    return {
      currency,
      name: WALLET_LABELS[currency] ?? currency,
      balance,
      formattedBalance: formatMoney(balance, currency),
      walletId: row?.wallet_id ?? null,
      accountNumber: row?.account_number ?? null,
      bankName: row?.bank_name ?? null,
    };
  });
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
 * PRD home response: sum of all wallet balances in USD equivalent.
 */
export function formatPrdWalletDetails(
  wallets: WalletRow[],
  totalUsdEquivalent: number
) {
  const walletBalances = formatWalletBalanceRows(wallets);
  const ledger = formatLedgerBalances(wallets);

  return {
    totalAvailableBalance: {
      currency: PRIMARY_CURRENCY,
      amount: totalUsdEquivalent,
      formatted: formatMoney(totalUsdEquivalent, PRIMARY_CURRENCY),
    },
    walletBalances,
    /** Alias for PRD GET /wallets/balances */
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

  const balance =
    ledgerBalance != null ? ledgerBalance : 0;

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
    creditsTo: currency,
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
  return sorted.map((row) => {
    const c = String(row.currency ?? '').toUpperCase();
    const bal = walletBalance(wallets, c);
    return formatGreyAccountForUi(row, bal);
  });
}
