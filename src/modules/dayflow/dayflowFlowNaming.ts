export type NamingInput = {
  categories?: { name: string; allocated?: number }[];
  schedules?: { title: string; amount?: number }[];
  periodLabel?: string;
};

const SCHOOL = /school|tuition|fees|textbook|text book|project|semester|uni|university|college/i;
const RENT = /rent|landlord|housing|apartment/i;
const FAMILY = /mom|mum|mother|dad|father|parent|remit|family|allowance/i;
const FOOD = /food|grocer|chow|restaurant|eat/i;
const BILLS = /electric|nepa|phcn|ikeja|eko disc|data|airtime|dstv|gotv|utility|bill/i;

function primaryTheme(names: string[]): string | null {
  const joined = names.join(' ').toLowerCase();
  if (SCHOOL.test(joined)) return 'School';
  if (RENT.test(joined)) return 'Rent';
  if (FAMILY.test(joined)) return 'Family support';
  if (FOOD.test(joined)) return 'Food & living';
  if (BILLS.test(joined)) return 'Bills';
  return null;
}

function formatNgn(amount: number): string {
  if (amount >= 1_000_000) {
    return `₦${(amount / 1_000_000).toFixed(amount % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (amount >= 1_000) {
    return `₦${Math.round(amount / 1_000)}k`;
  }
  return `₦${Math.round(amount).toLocaleString('en-NG')}`;
}

/**
 * Auto-generate a flow title from categories / scheduled payments.
 * e.g. "School · ₦120k · June", "Rent & food · ₦500k"
 */
export function buildSmartFlowTitle(input: NamingInput): string {
  const catNames = (input.categories ?? []).map((c) => c.name.trim()).filter(Boolean);
  const schedTitles = (input.schedules ?? []).map((s) => s.title.trim()).filter(Boolean);
  const allNames = [...catNames, ...schedTitles];

  const total =
    (input.categories ?? []).reduce((s, c) => s + Number(c.allocated ?? 0), 0) ||
    (input.schedules ?? []).reduce((s, x) => s + Number(x.amount ?? 0), 0);

  const theme = primaryTheme(allNames);
  const period = (input.periodLabel ?? '').trim();

  if (theme && total > 0) {
    const parts = [theme, formatNgn(total)];
    if (period) parts.push(period);
    return parts.join(' · ');
  }

  if (catNames.length === 1 && total > 0) {
    return `${catNames[0]} · ${formatNgn(total)}`;
  }

  if (catNames.length >= 2 && total > 0) {
    const short = catNames.slice(0, 2).join(' & ');
    const suffix = catNames.length > 2 ? ` +${catNames.length - 2}` : '';
    return `${short}${suffix} · ${formatNgn(total)}`;
  }

  if (total > 0) {
    return period ? `My plan · ${formatNgn(total)} · ${period}` : `My plan · ${formatNgn(total)}`;
  }

  return period ? `DayFlow · ${period}` : 'My DayFlow plan';
}

export function inferFlowType(input: NamingInput): 'savings' | 'bills' | 'mixed' {
  const names = [
    ...(input.categories ?? []).map((c) => c.name),
    ...(input.schedules ?? []).map((s) => s.title),
  ]
    .join(' ')
    .toLowerCase();

  const hasBills =
    BILLS.test(names) ||
    (input.schedules ?? []).some((s) => s.title && BILLS.test(s.title));
  const hasSavingsOnly =
    !hasBills &&
    (names.includes('saving') || names.includes('emergency') || names.includes('goal'));

  if (hasBills && !hasSavingsOnly) return 'bills';
  if (hasSavingsOnly && !hasBills) return 'savings';
  return 'mixed';
}
