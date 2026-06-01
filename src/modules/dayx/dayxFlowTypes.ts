export type DayxFlowId = 'send' | 'swap' | 'pay' | 'add_money';

export type DayxFlowAction = 'start' | 'select' | 'submit' | 'cancel';

export type DayxFlowInputType =
  | 'none'
  | 'text'
  | 'amount'
  | 'multiline';

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

export type DayxFlowUi = {
  step: string;
  title?: string;
  options?: DayxFlowOption[];
  input?: DayxFlowInput;
  review?: DayxFlowReviewLine[];
  showBack?: boolean;
};

export type DayxFlowExecutePayload = {
  type: string;
  [key: string]: unknown;
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
};

export type DayxFlowTurnResult = {
  reply: string;
  session: DayxFlowSession | null;
  ui?: DayxFlowUi;
  awaitingPin?: boolean;
  execute?: DayxFlowExecutePayload;
  completed?: boolean;
  navigateTarget?: string;
};
