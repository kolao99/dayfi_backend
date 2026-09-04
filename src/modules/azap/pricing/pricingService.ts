/**
 * Authoritative pricing — LLM must never invent fees.
 * Values are placeholders until commercial config is loaded from Dayfi.
 */

export type AzapPriceQuote = {
  service: string;
  currency: string;
  fee: number;
  description: string;
};

const DEFAULT_PRICES: AzapPriceQuote[] = [
  {
    service: 'bank_transfer',
    currency: 'NGN',
    fee: 0,
    description: 'Instant bank transfer',
  },
  {
    service: 'balance_check',
    currency: 'NGN',
    fee: 0,
    description: 'Balance check',
  },
  {
    service: 'airtime_purchase',
    currency: 'NGN',
    fee: 0,
    description: 'Airtime top-up',
  },
];

export async function getAzapCharges(): Promise<AzapPriceQuote[]> {
  // Future: load from Dayfi pricing / config table.
  return DEFAULT_PRICES.map((p) => ({ ...p }));
}

export async function quoteServiceFee(
  service: string
): Promise<AzapPriceQuote | null> {
  const all = await getAzapCharges();
  return all.find((p) => p.service === service) ?? null;
}

export function formatChargesMessage(quotes: AzapPriceQuote[]): string {
  const lines = quotes.map((q) => {
    const fee =
      q.fee === 0
        ? 'Free for now'
        : `${q.currency} ${q.fee.toLocaleString('en-NG')}`;
    return `• ${q.description}: ${fee}`;
  });
  return (
    `Azap Charges\n\n` +
    `${lines.join('\n')}\n\n` +
    `Fees come from Azap's pricing service — never invented in chat.`
  );
}

export function isChargesQuery(text: string): boolean {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    q === '/charges' ||
    q === 'azap charges' ||
    q === 'charges' ||
    /how much (do you|does|is).*(charge|transfer|fee)/.test(q) ||
    /what does.*(cost|charge)/.test(q)
  );
}
