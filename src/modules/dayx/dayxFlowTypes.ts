export type DayxFlowId = 'send' | 'swap' | 'pay' | 'add_money';

export type DayxFlowAction =
  | 'start'
  | 'select'
  | 'submit'
  | 'cancel'
  | 'utterance';

export type DayxFlowInputType =
  | 'none'
  | 'text'
  | 'amount'
  | 'multiline'
  | 'pin';

export type DayxFlowOption = {
  id: string;
  label: string;
  subtitle?: string;
};

export type DayxFlowInput = {
  type: DayxFlowInputType;
  field: string;
  label: string;
  placeholder?: string;
  keyboard?: 'default' | 'number' | 'phone';
};

export type DayxFlowReviewLine = {
  label: string;
  value: string;
};

/** Inline add-money / receive details (no navigation). */
export type DayxFlowDepositPanel = {
  currency: string;
  tabs: Array<'username' | 'bank' | 'crypto'>;
  dayfiId?: string;
  bankDetails?: {
    bankName?: string;
    accountNumber?: string;
    iban?: string;
    routingNumber?: string;
    accountName?: string;
    isDemo?: boolean;
  };
  cryptoDetails?: {
    coinLabel: string;
    stellarAddress?: string;
    ethAddress?: string;
  };
};

export type DayxFlowUi = {
  step: string;
  title?: string;
  options?: DayxFlowOption[];
  input?: DayxFlowInput;
  review?: DayxFlowReviewLine[];
  showBack?: boolean;
  /** Rich panel rendered in overlay instead of navigating. */
  panel?: 'deposit' | 'insufficient_balance';
  deposit?: DayxFlowDepositPanel;
  /** Shown on review / amount steps */
  rateLine?: string;
  hint?: string;
};

export type DayxFlowExecutePayload = {
  type: string;
  [key: string]: unknown;
};

export type DayxFlowWalletBalance = {
  currency: string;
  balance: number;
  symbol?: string;
};

export type DayxFlowSession = {
  flow: DayxFlowId;
  step: string;
  data: Record<string, unknown>;
};

export type DayxFlowTurnBody = {
  flow: DayxFlowId;
  action: DayxFlowAction;
  session?: DayxFlowSession | null;
  optionId?: string;
  field?: string;
  value?: string | number;
  /** Natural-language kickoff (voice/chat). */
  utterance?: string;
  /** Client wallet hub snapshot for balance checks & spend wallet list. */
  walletBalances?: DayxFlowWalletBalance[];
  /** Pre-select swap "from" wallet (e.g. current wallet detail screen). */
  preferredFromCurrency?: string;
};

export type DayxFlowTurnResult = {
  reply: string;
  session: DayxFlowSession | null;
  ui?: DayxFlowUi;
  awaitingPin?: boolean;
  execute?: DayxFlowExecutePayload;
  completed?: boolean;
  /** Deprecated — avoid for money flows; kept for support-only. */
  navigateTarget?: string;
};
