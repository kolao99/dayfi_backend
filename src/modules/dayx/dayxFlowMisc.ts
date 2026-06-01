import { BillsService } from '../payment/billsService';
import type { DayxFlowContext } from './dayxFlowContext';
import { buildPinSubmitTurn } from './dayxFlowPin';
import { buildSlotAck, slotsToSessionData } from './dayxFlowSlots';
import { extractFlowSlots } from './dayxSlotExtractor';
import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
  DayxFlowDepositPanel,
} from './dayxFlowTypes';
const billsService = new BillsService();

const LOCAL_BILL_CATEGORIES = [
  { id: 'AIRTIME', label: 'Airtime', subtitle: 'Phone top-up' },
  { id: 'MOBILEDATA', label: 'Data', subtitle: 'Mobile data bundles' },
  { id: 'UTILITYBILLS', label: 'Electricity', subtitle: 'Meter payment' },
  { id: 'CABLEBILLS', label: 'Cable TV', subtitle: 'DSTV, GOtv, etc.' },
  { id: 'INTERNET', label: 'Internet', subtitle: 'Broadband' },
];

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

function withData(
  session: DayxFlowSession,
  patch: Record<string, unknown>
): DayxFlowSession {
  return { ...session, data: { ...data(session), ...patch } };
}

async function mergePaySlots(
  session: DayxFlowSession,
  utterance?: string
): Promise<DayxFlowSession> {
  const slots = await extractFlowSlots(utterance);
  return withData(session, slotsToSessionData(slots, 'pay'));
}

async function pickBiller(
  categoryCode: string,
  hint?: string
): Promise<{ code: string; name: string } | null> {
  const billers = await billsService.getBillers(categoryCode);
  const list = Array.isArray(billers) ? billers : [];
  if (!list.length) return null;
  if (hint) {
    const h = hint.toLowerCase();
    const row = (list as Record<string, unknown>[]).find((b) =>
      String(b.name ?? b.short_name ?? '')
        .toLowerCase()
        .includes(h)
    );
    if (row) {
      return {
        code: String(row.biller_code ?? row.code ?? ''),
        name: String(row.name ?? row.short_name ?? 'Biller'),
      };
    }
  }
  const first = list[0] as Record<string, unknown>;
  return {
    code: String(first.biller_code ?? first.code ?? ''),
    name: String(first.name ?? first.short_name ?? 'Biller'),
  };
}

async function pickDefaultItem(
  billerCode: string
): Promise<{ itemCode: string; itemName?: string; amount?: number } | null> {
  const items = await billsService.getItems(billerCode);
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const item = list[0] as Record<string, unknown>;
  const amt = Number(item.amount ?? 0);
  return {
    itemCode: String(item.item_code ?? item.code ?? ''),
    itemName: String(item.short_name ?? item.name ?? ''),
    amount: amt > 0 ? amt : undefined,
  };
}

async function advancePay(
  session: DayxFlowSession,
  ack?: string
): Promise<DayxFlowTurnResult> {
  const d = data(session);
  const prefix = ack ?? buildSlotAck(d, 'pay');

  if (d.scope === 'international') {
    return {
      reply:
        'International bill payments are coming soon. Would you like to pay a local bill instead?',
      session: { flow: 'pay', step: 'select_scope', data: { scope: 'local' } },
      ui: {
        step: 'select_scope',
        title: 'Bill type',
        options: [
          { id: 'local', label: 'Pay local bill instead', subtitle: 'NGN' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    };
  }

  if (d.categoryCode && !d.scope) {
    session = withData(session, { scope: 'local' });
  }
  const dScoped = data(session);
  if (!dScoped.categoryCode) {
    return {
      reply: prefix
        ? `${prefix} What kind of bill?`
        : 'Pay a local bill in Nigeria, or choose international (coming soon).',
      session: { flow: 'pay', step: 'select_scope', data: { scope: dScoped.scope ?? 'local' } },
      ui: {
        step: 'select_scope',
        title: 'Bill type',
        options: [
          { id: 'local', label: 'Local bill (Nigeria)', subtitle: 'NGN' },
          {
            id: 'international',
            label: 'International bill',
            subtitle: 'Coming soon',
          },
        ],
      },
    };
  }

  const categoryCode = String(dScoped.categoryCode);
  let working = session;
  const dWork = () => data(working);

  if (!dWork().billerCode) {
    const biller = await pickBiller(
      categoryCode,
      dWork().provider_hint ? String(dWork().provider_hint) : undefined
    );
    if (!biller) {
      return {
        reply: 'No billers found for that category. Try another.',
        session: working,
      };
    }
    const item = await pickDefaultItem(biller.code);
    working = withData(working, {
      billerCode: biller.code,
      billerName: biller.name,
      scope: 'local',
    });
    if (item) {
      working = withData(working, {
        itemCode: item.itemCode,
        itemName: item.itemName,
        presetAmount: item.amount,
      });
    }
    return advancePay(working, prefix);
  }

  const cat = categoryCode.toUpperCase();
  const skipPlan =
    cat === 'AIRTIME' ||
    (dWork().amount && Number(dWork().amount) > 0) ||
    Boolean(dWork().itemCode);

  if (!dWork().itemCode && !skipPlan) {
    const items = await billsService.getItems(String(dWork().billerCode));
    const list = Array.isArray(items) ? items : [];
    if (list.length > 1) {
      const options = (list as Record<string, unknown>[])
        .slice(0, 12)
        .map((item) => ({
          id: String(item.item_code ?? item.code ?? ''),
          label: String(item.short_name ?? item.name ?? item.item_code ?? 'Plan'),
          subtitle: item.amount
            ? `₦${Number(item.amount).toLocaleString()}`
            : undefined,
        }));
      return {
        reply: prefix ? `${prefix} Pick a package.` : 'Pick a package or plan.',
        session: { ...working, step: 'select_item' },
        ui: {
          step: 'select_item',
          title: 'Package',
          options,
          showBack: true,
        },
      };
    }
    if (list.length === 1) {
      const item = list[0] as Record<string, unknown>;
      working = withData(working, {
        itemCode: String(item.item_code ?? item.code ?? ''),
        itemName: item.short_name ?? item.name,
        presetAmount: Number(item.amount ?? 0) || undefined,
      });
      return advancePay(working, prefix);
    }
  }

  if (!dWork().customerId) {
    return {
      reply: prefix
        ? `${prefix} ${customerIdPrompt(categoryCode)}`
        : customerIdPrompt(categoryCode),
      session: { ...working, step: 'input_customer' },
      ui: {
        step: 'input_customer',
        title: 'Customer ID',
        input: {
          type: 'text',
          field: 'customerId',
          label: customerIdLabel(categoryCode),
          placeholder: customerIdPlaceholder(categoryCode),
          keyboard: 'default',
        },
        showBack: true,
      },
    };
  }

  const amount = Number(dWork().amount ?? dWork().presetAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    if (cat === 'AIRTIME' || cat === 'UTILITYBILLS') {
      return {
        reply: prefix
          ? `${prefix} How much (NGN)?`
          : 'How much are you paying (NGN)?',
        session: { ...working, step: 'input_amount' },
        ui: {
          step: 'input_amount',
          title: 'Amount (NGN)',
          input: {
            type: 'amount',
            field: 'amount',
            label: 'Amount',
            keyboard: 'number',
          },
          showBack: true,
        },
      };
    }
    return advancePayReview(working, {
      ...dWork(),
      amount: Number(dWork().presetAmount ?? 0),
    });
  }

  return advancePayReview(working, { ...dWork(), amount });
}

export function depositTabsFor(currency: string): Array<'username' | 'bank' | 'crypto'> {
  const c = currency.toUpperCase();
  if (c === 'USD' || c === 'EUR') {
    return ['username', 'bank', 'crypto'];
  }
  return ['username', 'bank'];
}

export function depositPanel(currency: string): DayxFlowDepositPanel {
  const c = currency.toUpperCase();
  return {
    currency: c,
    tabs: depositTabsFor(c),
    cryptoDetails:
      c === 'USD' || c === 'EUR'
        ? { coinLabel: c === 'EUR' ? 'EURC' : 'USDC' }
        : undefined,
  };
}

function categoryCodeToBillCategory(
  code: string
): 'airtime' | 'data' | 'electricity' | 'cable' | 'internet' | undefined {
  const c = code.toUpperCase();
  if (c === 'AIRTIME') return 'airtime';
  if (c === 'MOBILEDATA') return 'data';
  if (c === 'UTILITYBILLS') return 'electricity';
  if (c === 'CABLEBILLS') return 'cable';
  if (c === 'INTERNET') return 'internet';
  return undefined;
}

export async function handlePayFlowTurn(
  body: DayxFlowTurnBody,
  _ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  let session: DayxFlowSession = body.session ?? {
    flow: 'pay',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return { reply: 'Bill payment cancelled.', session: null };
  }

  if (body.action === 'utterance' && body.utterance?.trim()) {
    const s = await mergePaySlots(session, body.utterance);
    return advancePay(s);
  }

  if (body.action === 'start' || session.step === 'idle') {
    const s = await mergePaySlots(
      { flow: 'pay', step: 'advance', data: {} },
      body.utterance ?? _ctx.utterance
    );
    return advancePay(s);
  }

  if (body.action === 'submit' && body.utterance?.trim()) {
    const s = await mergePaySlots(session, body.utterance);
    return advancePay(s);
  }

  if (session.step === 'select_scope' && body.action === 'select') {
    if (body.optionId === 'international') {
      return advancePay(withData(session, { scope: 'international' }));
    }
    if (body.optionId === 'cancel') {
      return { reply: 'Bill payment cancelled.', session: null };
    }
    session = withData(session, { scope: 'local' });
    if (!data(session).categoryCode) {
      return {
        reply: 'What kind of bill? Airtime, data, electricity, cable, or internet.',
        session: { ...session, step: 'select_category' },
        ui: {
          step: 'select_category',
          title: 'Bill category',
          options: LOCAL_BILL_CATEGORIES,
          showBack: true,
        },
      };
    }
    return advancePay(session);
  }

  if (session.step === 'select_category' && body.action === 'select') {
    const categoryCode = body.optionId ?? '';
    session = withData(
      { ...session, step: 'advance' },
      {
        categoryCode,
        bill_category: categoryCodeToBillCategory(categoryCode),
        scope: 'local',
      }
    );
    return advancePay(session);
  }

  if (session.step === 'select_biller' && body.action === 'select') {
    const billerCode = body.optionId ?? '';
    const billers = await billsService.getBillers(
      String(data(session).categoryCode ?? '')
    );
    const billerList = Array.isArray(billers) ? billers : [];
    const billerRow = (billerList as Record<string, unknown>[]).find(
      (b) => String(b.biller_code ?? b.code) === billerCode
    );
    const billerName = String(
      billerRow?.name ?? billerRow?.short_name ?? billerCode
    );
    const items = await billsService.getItems(billerCode);
    const list = Array.isArray(items) ? items : [];

    if (list.length > 1) {
      const options = (list as Record<string, unknown>[])
        .slice(0, 12)
        .map((item) => ({
          id: String(item.item_code ?? item.code ?? ''),
          label: String(
            item.short_name ?? item.name ?? item.item_code ?? 'Plan'
          ),
          subtitle: item.amount
            ? `₦${Number(item.amount).toLocaleString()}`
            : undefined,
        }));

      return {
        reply: 'Pick a package or plan.',
        session: {
          flow: 'pay',
          step: 'select_item',
          data: { ...session.data, billerCode, billerName },
        },
        ui: {
          step: 'select_item',
          title: 'Package',
          options,
          showBack: true,
        },
      };
    }

    const item = (list[0] as Record<string, unknown>) ?? {};
    const itemCode = String(item.item_code ?? item.code ?? '');
    const presetAmount = Number(item.amount ?? 0);

    return {
      reply: customerIdPrompt(String(session.data?.categoryCode ?? '')),
      session: {
        flow: 'pay',
        step: 'input_customer',
        data: {
          ...session.data,
          billerCode,
          billerName,
          itemCode,
          presetAmount: presetAmount > 0 ? presetAmount : undefined,
        },
      },
      ui: {
        step: 'input_customer',
        title: 'Customer ID',
        input: {
          type: 'text',
          field: 'customerId',
          label: customerIdLabel(String(session.data?.categoryCode ?? '')),
          placeholder: customerIdPlaceholder(
            String(session.data?.categoryCode ?? '')
          ),
          keyboard: 'default',
        },
        showBack: true,
      },
    };
  }

  if (session.step === 'select_item' && body.action === 'select') {
    const itemCode = body.optionId ?? '';
    const items = await billsService.getItems(String(data(session).billerCode));
    const list = Array.isArray(items) ? items : [];
    const item = (list as Record<string, unknown>[]).find(
      (i) => String(i.item_code ?? i.code) === itemCode
    );
    const presetAmount = Number(item?.amount ?? 0);

    return {
      reply: customerIdPrompt(String(data(session).categoryCode ?? '')),
      session: {
        flow: 'pay',
        step: 'input_customer',
        data: {
          ...session.data,
          itemCode,
          itemName: item?.short_name ?? item?.name,
          presetAmount: presetAmount > 0 ? presetAmount : undefined,
        },
      },
      ui: {
        step: 'input_customer',
        title: 'Customer ID',
        input: {
          type: 'text',
          field: 'customerId',
          label: customerIdLabel(String(data(session).categoryCode ?? '')),
          keyboard: 'default',
        },
        showBack: true,
      },
    };
  }

  if (session.step === 'input_customer' && body.action === 'submit') {
    const customerId = String(body.value ?? '').trim();
    if (!customerId) {
      return { reply: 'Enter a customer ID or phone number.', session };
    }
    const d = data(session);
    const preset = Number(d.presetAmount ?? 0);
    if (preset > 0) {
      return advancePayReview(session, { ...d, customerId, amount: preset });
    }
    return {
      reply: 'How much are you paying (NGN)?',
      session: {
        flow: 'pay',
        step: 'input_amount',
        data: { ...d, customerId },
      },
      ui: {
        step: 'input_amount',
        title: 'Amount (NGN)',
        input: {
          type: 'amount',
          field: 'amount',
          label: 'Amount',
          keyboard: 'number',
        },
        showBack: true,
      },
    };
  }

  if (session.step === 'input_amount' && body.action === 'submit') {
    const amount = Number(body.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { reply: 'Enter a valid amount.', session };
    }
    return advancePayReview(session, { ...data(session), amount });
  }

  if (session.step === 'review' && body.action === 'select') {
    if (body.optionId === 'cancel') {
      return { reply: 'Cancelled.', session: null };
    }
    if (body.optionId === 'confirm') {
      const d = data(session);
      return {
        reply: 'Enter your PIN to pay this bill.',
        session: { ...session, step: 'collect_pin' },
        awaitingPin: true,
        execute: {
          type: 'pay_bill',
          categoryCode: String(d.categoryCode),
          billerCode: String(d.billerCode),
          itemCode: String(d.itemCode),
          customerId: String(d.customerId),
          amount: Number(d.amount),
          billerName: String(d.billerName ?? ''),
          itemName: String(d.itemName ?? ''),
        },
        ui: {
          step: 'collect_pin',
          title: 'Transaction PIN',
          input: {
            type: 'pin',
            field: 'pin',
            label: '4-digit PIN',
            keyboard: 'number',
          },
        },
      };
    }
  }

  if (session.step === 'collect_pin' && body.action === 'submit') {
    const pin = String(body.value ?? '').trim();
    const d = data(session);
    if (pin.length < 4) {
      return { reply: 'Enter your 4-digit PIN.', session };
    }
    return buildPinSubmitTurn(session, {
      type: 'pay_bill',
      categoryCode: String(d.categoryCode),
      billerCode: String(d.billerCode),
      itemCode: String(d.itemCode),
      customerId: String(d.customerId),
      amount: Number(d.amount),
      billerName: String(d.billerName ?? ''),
      itemName: String(d.itemName ?? ''),
    }, pin);
  }

  return advancePay(session);
}

function advancePayReview(
  session: DayxFlowSession,
  d: Record<string, unknown>
): DayxFlowTurnResult {
  const amount = Number(d.amount);
  return {
    reply: 'Review your bill payment.',
    session: { ...session, step: 'review', data: d },
    ui: {
      step: 'review',
      title: 'Review bill',
      review: [
        { label: 'Amount', value: `NGN ${amount.toLocaleString()}` },
        { label: 'Customer', value: String(d.customerId) },
        { label: 'Biller', value: String(d.billerName ?? d.billerCode ?? '') },
      ],
      options: [
        { id: 'confirm', label: 'Confirm & enter PIN' },
        { id: 'cancel', label: 'Cancel' },
      ],
    },
  };
}

function customerIdPrompt(categoryCode: string): string {
  const c = categoryCode.toUpperCase();
  if (c === 'AIRTIME' || c === 'MOBILEDATA') {
    return 'Enter the phone number to recharge.';
  }
  if (c === 'CABLEBILLS') return 'Enter smartcard / IUC number.';
  if (c === 'UTILITYBILLS') return 'Enter meter number.';
  return 'Enter customer or account number.';
}

function customerIdLabel(categoryCode: string): string {
  const c = categoryCode.toUpperCase();
  if (c === 'AIRTIME' || c === 'MOBILEDATA') return 'Phone number';
  if (c === 'CABLEBILLS') return 'Smartcard / IUC';
  if (c === 'UTILITYBILLS') return 'Meter number';
  return 'Customer ID';
}

function customerIdPlaceholder(categoryCode: string): string {
  const c = categoryCode.toUpperCase();
  if (c === 'AIRTIME' || c === 'MOBILEDATA') return '08012345678';
  return 'Enter ID';
}

