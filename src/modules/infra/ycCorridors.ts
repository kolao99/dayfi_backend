/**
 * Yellow Card off-ramp corridors — mirrors mobile
 * `lib/features/send/constants/yellow_card_corridors.dart`
 * https://docs.yellowcard.engineering/v1.0.26/docs/africa
 */

export type YcCorridor = {
  countryCode: string;
  currency: string;
  name: string;
  bank: boolean;
  mobileMoney: boolean;
};

export const YELLOW_CARD_OFF_RAMP_CORRIDORS: YcCorridor[] = [
  { countryCode: 'BJ', currency: 'XOF', name: 'Benin', bank: false, mobileMoney: true },
  { countryCode: 'BW', currency: 'BWP', name: 'Botswana', bank: true, mobileMoney: true },
  { countryCode: 'BF', currency: 'XOF', name: 'Burkina Faso', bank: false, mobileMoney: true },
  { countryCode: 'CM', currency: 'XAF', name: 'Cameroon', bank: false, mobileMoney: true },
  { countryCode: 'CG', currency: 'XAF', name: 'Congo', bank: true, mobileMoney: false },
  { countryCode: 'CD', currency: 'CDF', name: 'DR Congo', bank: false, mobileMoney: true },
  { countryCode: 'CI', currency: 'XOF', name: 'Côte d’Ivoire', bank: false, mobileMoney: true },
  { countryCode: 'GA', currency: 'XAF', name: 'Gabon', bank: true, mobileMoney: false },
  { countryCode: 'MW', currency: 'MWK', name: 'Malawi', bank: true, mobileMoney: true },
  { countryCode: 'ML', currency: 'XOF', name: 'Mali', bank: false, mobileMoney: true },
  { countryCode: 'RW', currency: 'RWF', name: 'Rwanda', bank: true, mobileMoney: false },
  { countryCode: 'SN', currency: 'XOF', name: 'Senegal', bank: false, mobileMoney: true },
  { countryCode: 'ZA', currency: 'ZAR', name: 'South Africa', bank: true, mobileMoney: false },
  { countryCode: 'KE', currency: 'KES', name: 'Kenya', bank: true, mobileMoney: true },
  { countryCode: 'GH', currency: 'GHS', name: 'Ghana', bank: true, mobileMoney: true },
  { countryCode: 'TZ', currency: 'TZS', name: 'Tanzania', bank: true, mobileMoney: true },
  { countryCode: 'TG', currency: 'XOF', name: 'Togo', bank: false, mobileMoney: true },
  { countryCode: 'UG', currency: 'UGX', name: 'Uganda', bank: true, mobileMoney: true },
  { countryCode: 'ZM', currency: 'ZMW', name: 'Zambia', bank: true, mobileMoney: true },
];

/** Priority order for Send destination list (mobile `kStandardAfricanCountryOrder`). */
export const CORRIDOR_SORT_ORDER = [
  'ZA', 'KE', 'GH', 'UG', 'TZ', 'RW', 'ZM', 'BW', 'MW', 'SN',
  'CM', 'CI', 'CD', 'CG', 'GA', 'BJ', 'BF', 'ML', 'TG',
];

export function sortCorridors<T extends { countryCode: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ia = CORRIDOR_SORT_ORDER.indexOf(a.countryCode);
    const ib = CORRIDOR_SORT_ORDER.indexOf(b.countryCode);
    const ra = ia >= 0 ? ia : 999;
    const rb = ib >= 0 ? ib : 999;
    if (ra !== rb) return ra - rb;
    return a.countryCode.localeCompare(b.countryCode);
  });
}
