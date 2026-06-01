import { BillsService } from '../payment/billsService';
import type { DayxFlowContext } from './dayxFlowContext';
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

export async function handlePayFlowTurn(
  body: DayxFlowTurnBody,
  _ctx: DayxFlowContext
): Promise<DayxFlowTurnResult> {
  const session: DayxFlowSession = body.session ?? {
    flow: 'pay',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return { reply: 'Bill payment cancelled.', session: null };
  }

  if (body.action === 'start' || session.step === 'idle') {
    return {
      reply:
        'Pay a bill in Nigeria, or choose international (coming soon).',
      session: { flow: 'pay', step: 'select_scope', data: {} },
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

  if (session.step === 'select_scope' && body.action === 'select') {
    if (body.optionId === 'international') {
      return {
        reply:
          'International bill pay is coming soon. You can pay local airtime, data, electricity, cable, and internet bills now.',
        session: { flow: 'pay', step: 'select_scope', data: {} },
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

    return {
      reply: 'What kind of bill? Airtime, data, electricity, cable, or internet.',
      session: { flow: 'pay', step: 'select_category', data: { scope: 'local' } },
      ui: {
        step: 'select_category',
        title: 'Bill category',
        options: LOCAL_BILL_CATEGORIES,
        showBack: true,
      },
    };
  }

  if (session.step === 'select_category' && body.action === 'select') {
    const categoryCode = body.optionId ?? '';
    const billers = await billsService.getBillers(categoryCode);
    const list = Array.isArray(billers) ? billers : [];
    if (!list.length) {
      return {
        reply: 'No billers found for that category. Try another.',
        session,
      };
    }

    const options = (list as Record<string, unknown>[])
      .slice(0, 20)
      .map((b) => ({
        id: String(b.biller_code ?? b.code ?? ''),
        label: String(b.name ?? b.short_name ?? 'Biller'),
        subtitle: String(b.biller_code ?? ''),
      }));

    return {
      reply: 'Choose a provider.',
      session: {
        flow: 'pay',
        step: 'select_biller',
        data: { ...session.data, categoryCode },
      },
      ui: {
        step: 'select_biller',
        title: 'Provider',
        options,
        showBack: true,
      },
    };
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
    return {
      reply: 'Processing payment…',
      session: null,
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
        pin,
      },
      completed: true,
    };
  }

  return { reply: 'Choose an option.', session };
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

