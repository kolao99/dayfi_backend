import PaymentService from '../payment/services';
import {
  countryLabel,
  loadWithdrawCorridors,
  methodsForCorridor,
  uniqueCorridors,
} from './dayxFlowChannels';
import type {
  DayxFlowSession,
  DayxFlowTurnBody,
  DayxFlowTurnResult,
  DayxFlowUi,
} from './dayxFlowTypes';

const paymentService = new PaymentService();

function data(session: DayxFlowSession): Record<string, unknown> {
  return session.data ?? {};
}

function withData(
  session: DayxFlowSession,
  patch: Record<string, unknown>
): DayxFlowSession {
  return {
    ...session,
    data: { ...data(session), ...patch },
  };
}

export async function handleSendFlowTurn(
  body: DayxFlowTurnBody
): Promise<DayxFlowTurnResult> {
  const session: DayxFlowSession = body.session ?? {
    flow: 'send',
    step: 'idle',
    data: {},
  };

  if (body.action === 'cancel') {
    return {
      reply: 'Send cancelled. What else can I help with?',
      session: null,
    };
  }

  if (body.action === 'start' || session.step === 'idle') {
    const corridors = uniqueCorridors(await loadWithdrawCorridors());
    const options = corridors.slice(0, 24).map((c) => ({
      id: `${c.country}|${c.currency}`,
      label: countryLabel(c.country),
      subtitle: c.currency,
    }));

    const next: DayxFlowSession = {
      flow: 'send',
      step: 'select_country',
      data: { corridors: corridors.length },
    };

    return {
      reply:
        'Where are you sending money? Pick a country below, or type the country name in chat.',
      session: next,
      ui: {
        step: 'select_country',
        title: 'Destination',
        options,
        showBack: false,
      },
    };
  }

  if (session.step === 'select_country' && body.action === 'select') {
    const raw = body.optionId ?? '';
    const [country, currency] = raw.split('|');
    if (!country || !currency) {
      return { reply: 'Please pick a country from the list.', session };
    }

    const channels = await loadWithdrawCorridors();
    const methods = methodsForCorridor(channels, country, currency);
    const next = withData(
      { ...session, step: 'select_method' },
      { receiveCountry: country, receiveCurrency: currency }
    );

    return {
      reply: `Got it — ${countryLabel(country)} (${currency}). How should they receive it?`,
      session: next,
      ui: {
        step: 'select_method',
        title: 'Delivery method',
        options: methods,
        showBack: true,
      },
    };
  }

  if (session.step === 'select_method' && body.action === 'select') {
    const method = body.optionId ?? 'bank';
    const country = String(data(session).receiveCountry ?? '');
    const currency = String(data(session).receiveCurrency ?? '');
    const next = withData(
      { ...session, step: 'collect_recipient' },
      { deliveryMethod: method }
    );

    if (method === 'dayfi_tag') {
      return {
        reply: 'Enter their Dayfi Tag (without @).',
        session: next,
        ui: {
          step: 'collect_recipient',
          title: 'Dayfi Tag',
          input: {
            type: 'text',
            field: 'dayfiId',
            label: 'Dayfi Tag',
            placeholder: 'e.g. kolawole',
            keyboard: 'default',
          },
          showBack: true,
        },
      };
    }

    if (method === 'bank' && country === 'NG' && currency === 'NGN') {
      const banks = await paymentService.fetchNigerianBankNetworks();
      const options = banks.slice(0, 30).map((b: (typeof banks)[number]) => ({
        id: b.code,
        label: b.name,
        subtitle: `Code ${b.code}`,
      }));

      return {
        reply: 'Choose their bank, then enter account number.',
        session: withData(next, { step: 'select_bank' }),
        ui: {
          step: 'select_bank',
          title: 'Bank',
          options,
          showBack: true,
        },
      };
    }

    if (method === 'crypto') {
      return {
        reply: 'Paste their wallet address below.',
        session: next,
        ui: {
          step: 'collect_recipient',
          title: 'Wallet address',
          input: {
            type: 'multiline',
            field: 'cryptoAddress',
            label: 'Wallet address',
            placeholder: 'Paste address',
            keyboard: 'default',
          },
          showBack: true,
        },
      };
    }

    return {
      reply:
        'This corridor works best in the full Send screen — I will open it for you.',
      session: null,
      navigateTarget: 'send',
    };
  }

  if (session.step === 'select_bank' && body.action === 'select') {
    const bankCode = body.optionId ?? '';
    const banks = await paymentService.fetchNigerianBankNetworks();
    const bank = banks.find(
      (b: (typeof banks)[number]) => b.code === bankCode
    );
    const next = withData(
      { ...session, step: 'collect_recipient' },
      {
        bankCode,
        bankName: bank?.name ?? 'Bank',
      }
    );
    return {
      reply: `Enter the account number for ${bank?.name ?? 'this bank'}.`,
      session: next,
      ui: {
        step: 'collect_recipient',
        title: 'Account number',
        input: {
          type: 'text',
          field: 'accountNumber',
          label: 'Account number',
          placeholder: '10 digits',
          keyboard: 'number',
        },
        showBack: true,
      },
    };
  }

  if (session.step === 'collect_recipient' && body.action === 'submit') {
    const field = body.field ?? '';
    const value = String(body.value ?? '').trim();
    if (!value) {
      return { reply: 'Please enter a value to continue.', session };
    }

    const d = data(session);
    const method = String(d.deliveryMethod ?? '');

    if (field === 'dayfiId') {
      const tag = value.replace(/^@/, '');
      const next = withData(
        { ...session, step: 'input_amount' },
        { dayfiId: tag, recipientName: tag }
      );
      return {
        reply: `Sending to @${tag}. How much?`,
        session: next,
        ui: amountUi(),
      };
    }

    if (field === 'accountNumber') {
      const bankCode = String(d.bankCode ?? '');
      try {
        const resolved = await paymentService.resolveBankAccount(
          value,
          bankCode
        );
        const accountName =
          resolved?.accountName ?? resolved?.account_name ?? 'Recipient';
        const next = withData(
          { ...session, step: 'input_amount' },
          {
            accountNumber: value,
            accountName: String(accountName),
          }
        );
        return {
          reply: `Account verified: ${accountName}. How much should I send?`,
          session: next,
          ui: amountUi(),
        };
      } catch (e: unknown) {
        return {
          reply:
            e instanceof Error
              ? e.message
              : 'Could not verify account. Check the number and try again.',
          session,
        };
      }
    }

    if (field === 'cryptoAddress') {
      return {
        reply: 'Crypto send from DayX is coming soon. Opening Send for you.',
        session: null,
        navigateTarget: 'send',
      };
    }

    if (method === 'mobile_money') {
      const next = withData(
        { ...session, step: 'input_amount' },
        { phone: value }
      );
      return {
        reply: 'How much should I send?',
        session: next,
        ui: amountUi(),
      };
    }
  }

  if (session.step === 'input_amount' && body.action === 'submit') {
    const amount = Number(body.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { reply: 'Enter a valid amount greater than zero.', session };
    }

    const d = data(session);
    const method = String(d.deliveryMethod ?? '');
    const currency = String(d.receiveCurrency ?? 'NGN');
    const next = withData({ ...session, step: 'review' }, { amount, currency });

    const review: { label: string; value: string }[] = [
      { label: 'Amount', value: `${currency} ${amount.toLocaleString()}` },
      {
        label: 'To',
        value: String(
          d.accountName ?? d.dayfiId ?? d.phone ?? d.recipientName ?? 'Recipient'
        ),
      },
      {
        label: 'Method',
        value: method === 'dayfi_tag' ? 'Dayfi Tag' : 'Bank transfer',
      },
    ];

    if (method === 'dayfi_tag') {
      return {
        reply: 'Review your transfer. Confirm with your transaction PIN next.',
        session: next,
        ui: {
          step: 'review',
          title: 'Review transfer',
          review,
          options: [
            { id: 'confirm', label: 'Confirm & enter PIN' },
            { id: 'cancel', label: 'Cancel' },
          ],
        },
        execute: {
          type: 'dayfi_tag',
          dayfiId: String(d.dayfiId ?? ''),
          amount: Math.round(amount),
          debitCurrency: currency === 'NGN' ? 'NGN' : 'USD',
        },
      };
    }

    if (method === 'bank' && d.accountNumber) {
      return {
        reply: 'Review your bank transfer. Confirm with your transaction PIN.',
        session: next,
        ui: {
          step: 'review',
          title: 'Review transfer',
          review,
          options: [
            { id: 'confirm', label: 'Confirm & enter PIN' },
            { id: 'cancel', label: 'Cancel' },
          ],
        },
        execute: {
          type: 'ngn_bank',
          amount,
          accountNumber: String(d.accountNumber),
          bankCode: String(d.bankCode ?? ''),
          bankName: String(d.bankName ?? 'Bank'),
          accountName: String(d.accountName ?? 'Recipient'),
          fee: 0,
          spendCurrency: 'NGN',
        },
      };
    }

    return {
      reply: 'Ready to review. Tap confirm to continue.',
      session: next,
      ui: {
        step: 'review',
        review,
        options: [{ id: 'confirm', label: 'Confirm' }],
      },
    };
  }

  if (session.step === 'review' && body.action === 'select') {
    if (body.optionId === 'cancel') {
      return { reply: 'Transfer cancelled.', session: null };
    }
    if (body.optionId === 'confirm') {
      const d = data(session);
      const method = String(d.deliveryMethod ?? '');
      const amount = Number(d.amount);

      if (method === 'dayfi_tag') {
        return {
          reply: 'Enter your transaction PIN to send.',
          session,
          awaitingPin: true,
          execute: {
            type: 'dayfi_tag',
            dayfiId: String(d.dayfiId ?? ''),
            amount: Math.round(amount),
            debitCurrency: String(d.receiveCurrency ?? 'USD'),
          },
        };
      }

      if (method === 'bank') {
        return {
          reply: 'Enter your transaction PIN to send.',
          session,
          awaitingPin: true,
          execute: {
            type: 'ngn_bank',
            amount,
            accountNumber: String(d.accountNumber ?? ''),
            bankCode: String(d.bankCode ?? ''),
            bankName: String(d.bankName ?? 'Bank'),
            accountName: String(d.accountName ?? 'Recipient'),
            fee: 0,
            spendCurrency: 'NGN',
          },
        };
      }
    }
  }

  return {
    reply: 'Tap an option above or say "cancel" to stop.',
    session,
  };
}

function amountUi(): DayxFlowUi {
  return {
    step: 'input_amount',
    title: 'Amount',
    input: {
      type: 'amount',
      field: 'amount',
      label: 'Amount',
      placeholder: '0.00',
      keyboard: 'number',
    },
    showBack: true,
  };
}
