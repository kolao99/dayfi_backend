/** Nigerian banks users expect first — matched by substring on API bank name. */
const POPULAR_NG_BANK_ALIASES: string[][] = [
  ['opay', 'paycom'],
  ['palmpay', 'palm pay'],
  ['gtbank', 'guaranty trust', 'gtb '],
  ['access bank', 'access'],
  ['united bank for africa', 'uba'],
  ['zenith'],
  ['kuda'],
  ['moniepoint', 'monie point'],
  ['first bank', 'firstbank', 'fbn'],
  ['fcmb', 'first city'],
  ['sterling'],
  ['wema', 'alat'],
  ['stanbic'],
  ['fidelity'],
  ['union bank'],
  ['polaris'],
  ['ecobank'],
  ['keystone'],
  ['providus'],
  ['jaiz'],
  ['unity bank'],
  ['heritage'],
  ['standard chartered'],
  ['citibank', 'citi bank'],
  ['suntrust'],
  ['taj bank'],
  ['lotus bank'],
  ['globus'],
];

export type NgBankRow = { code: string; name: string };

function popularRank(bankName: string): number {
  const n = bankName.toLowerCase();
  for (let i = 0; i < POPULAR_NG_BANK_ALIASES.length; i++) {
    if (POPULAR_NG_BANK_ALIASES[i].some((alias) => n.includes(alias))) {
      return i;
    }
  }
  return POPULAR_NG_BANK_ALIASES.length;
}

/** Popular banks first (Opay, PalmPay, GTB…), then the rest A–Z. */
export function sortNgBanksForPicker(banks: NgBankRow[]): NgBankRow[] {
  return [...banks].sort((a, b) => {
    const ra = popularRank(a.name);
    const rb = popularRank(b.name);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}
