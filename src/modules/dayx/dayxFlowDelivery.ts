import { countryLabel } from './dayxFlowChannels';
import type { DayxFlowOption } from './dayxFlowTypes';

/** PRD send wallets — same as mobile `kCoreSendCurrencies`. */
export const CORE_SEND_CURRENCIES = new Set(['USD', 'GBP', 'EUR', 'NGN']);

/** Global destinations shown in Send (matches mobile country picker). */
export const CORE_DESTINATION_OPTIONS: DayxFlowOption[] = [
  { id: 'NG|NGN', label: 'Nigeria', subtitle: 'NGN' },
  { id: 'US|USD', label: 'United States', subtitle: 'USD' },
  { id: 'DE|EUR', label: 'Euro', subtitle: 'EUR' },
  { id: 'GB|GBP', label: 'United Kingdom', subtitle: 'GBP' },
];

/**
 * Delivery methods for core fiat wallets — mirrors mobile `DeliveryMethodsSheet`
 * (`_buildCoreCurrencyMethods`). No Yellow Card dependency.
 */
export function coreDeliveryMethods(receiveCurrency: string): DayxFlowOption[] {
  const receive = receiveCurrency.toUpperCase();
  const methods: DayxFlowOption[] = [
    {
      id: 'dayfi_tag',
      label: 'Username',
      subtitle: 'FREE · Send to a username — instant',
    },
  ];

  if (receive === 'NGN') {
    methods.push({
      id: 'bank',
      label: 'Bank',
      subtitle: 'Transfer to a Nigerian bank account',
    });
  }

  if (receive === 'USD' || receive === 'EUR') {
    const coin = receive === 'EUR' ? 'EURC' : 'USDC';
    methods.push({
      id: 'crypto',
      label: 'Crypto',
      subtitle: `Send ${coin} on Stellar or Ethereum`,
    });
  }

  return methods;
}

export function isCoreReceiveCurrency(currency: string): boolean {
  return CORE_SEND_CURRENCIES.has(currency.toUpperCase());
}

export function deliveryMethodsForCorridor(
  receiveCountry: string,
  receiveCurrency: string
): DayxFlowOption[] {
  if (isCoreReceiveCurrency(receiveCurrency)) {
    return coreDeliveryMethods(receiveCurrency);
  }
  return [
    {
      id: 'dayfi_tag',
      label: 'Username',
      subtitle: 'FREE · Instant to another Dayfi user',
    },
    {
      id: 'bank',
      label: 'Bank transfer',
      subtitle: `Payout to ${countryLabel(receiveCountry)} (${receiveCurrency})`,
    },
    {
      id: 'mobile_money',
      label: 'Mobile money',
      subtitle: 'Phone / mobile wallet',
    },
  ];
}

export function methodStepReply(
  spendCurrency: string,
  receiveCurrency: string
): string {
  const spend = spendCurrency.toUpperCase();
  const receive = receiveCurrency.toUpperCase();
  return `Send ${receive} from your ${spend} wallet. How should they receive it?`;
}
