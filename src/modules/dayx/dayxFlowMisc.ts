import { BillsService } from '../payment/billsService';
import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
} from './dayxFlowTypes';

const billsService = new BillsService();

export async function handlePayFlowTurn(
  body: DayxFlowTurnBody
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
    const categories = await billsService.getCategories();
    const list = Array.isArray(categories) ? categories : [];
    const options = (list as Record<string, unknown>[])
      .slice(0, 12)
      .map((c) => ({
      id: String(c.code ?? c.category ?? ''),
      label: String(c.name ?? c.code ?? 'Bill'),
      subtitle: String(c.code ?? ''),
    }));

    return {
      reply: 'What type of bill are you paying?',
      session: { flow: 'pay', step: 'select_category', data: {} },
      ui: {
        step: 'select_category',
        title: 'Bill category',
        options,
      },
    };
  }

  if (session.step === 'select_category' && body.action === 'select') {
    const categoryCode = body.optionId ?? '';
    const billers = await billsService.getBillers(categoryCode);
    const list = Array.isArray(billers) ? billers : [];
    if (!list.length) {
      return {
        reply: 'No billers found. Opening Pay in the app.',
        session: null,
        navigateTarget: 'pay',
      };
    }

    const options = (list as Record<string, unknown>[])
      .slice(0, 15)
      .map((b) => ({
      id: String(b.biller_code ?? b.code ?? ''),
      label: String(b.name ?? b.short_name ?? 'Biller'),
    }));

    return {
      reply: 'Choose a biller.',
      session: {
        flow: 'pay',
        step: 'select_biller',
        data: { categoryCode },
      },
      ui: {
        step: 'select_biller',
        title: 'Biller',
        options,
        showBack: true,
      },
    };
  }

  if (session.step === 'select_biller' && body.action === 'select') {
    const billerCode = body.optionId ?? '';
    const items = await billsService.getItems(billerCode);
    const list = Array.isArray(items) ? items : [];
    const item = (list[0] as Record<string, unknown>) ?? {};
    const itemCode = String(item.item_code ?? item.code ?? '');

    return {
      reply: 'Enter your meter / phone / customer ID, then the amount.',
      session: {
        flow: 'pay',
        step: 'input_customer',
        data: {
          ...session.data,
          billerCode,
          itemCode,
          billerName: body.optionId,
        },
      },
      ui: {
        step: 'input_customer',
        title: 'Customer ID',
        input: {
          type: 'text',
          field: 'customerId',
          label: 'Customer / meter / phone number',
          placeholder: 'Enter ID',
          keyboard: 'default',
        },
        showBack: true,
      },
    };
  }

  if (session.step === 'input_customer' && body.action === 'submit') {
    const customerId = String(body.value ?? '').trim();
    if (!customerId) {
      return { reply: 'Enter a customer ID.', session };
    }
    return {
      reply: 'How much are you paying?',
      session: {
        flow: 'pay',
        step: 'input_amount',
        data: { ...session.data, customerId },
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
    const d = session.data ?? {};
    return {
      reply: 'Review your bill payment.',
      session: { ...session, step: 'review', data: { ...d, amount } },
      ui: {
        step: 'review',
        review: [
          { label: 'Amount', value: `NGN ${amount.toLocaleString()}` },
          { label: 'Customer', value: String(d.customerId) },
        ],
        options: [
          { id: 'confirm', label: 'Confirm & enter PIN' },
          { id: 'cancel', label: 'Cancel' },
        ],
      },
    };
  }

  if (session.step === 'review' && body.action === 'select') {
    if (body.optionId === 'cancel') {
      return { reply: 'Cancelled.', session: null };
    }
    if (body.optionId === 'confirm') {
      const d = session.data ?? {};
      return {
        reply: 'Enter your PIN to pay this bill.',
        session,
        awaitingPin: true,
        execute: {
          type: 'pay_bill',
          categoryCode: String(d.categoryCode),
          billerCode: String(d.billerCode),
          itemCode: String(d.itemCode),
          customerId: String(d.customerId),
          amount: Number(d.amount),
          billerName: String(d.billerName ?? ''),
        },
      };
    }
  }

  return { reply: 'Choose an option.', session };
}

export function handleAddMoneyFlowTurn(
  body: DayxFlowTurnBody
): DayxFlowTurnResult {
  const session: DayxFlowSession = body.session ?? {
    flow: 'add_money',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return { reply: 'Cancelled.', session: null };
  }

  if (body.action === 'start' || session.step === 'idle') {
    return {
      reply: 'Which wallet do you want to fund?',
      session: { flow: 'add_money', step: 'select_currency', data: {} },
      ui: {
        step: 'select_currency',
        title: 'Add money',
        options: ['USD', 'NGN', 'EUR', 'GBP'].map((c) => ({
          id: c,
          label: c,
        })),
      },
    };
  }

  if (session.step === 'select_currency' && body.action === 'select') {
    const currency = (body.optionId ?? 'USD').toUpperCase();
    return {
      reply: `To add ${currency}, I'll open your deposit details — bank account, crypto, or Dayfi Tag.`,
      session: null,
      navigateTarget: 'add_money',
      completed: true,
    };
  }

  return { reply: 'Pick a wallet to fund.', session };
}
