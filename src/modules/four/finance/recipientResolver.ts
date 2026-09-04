import PaymentService from '../../payment/services';
import { listSavedRecipients } from '../../payment/savedRecipientService';
import type { BankTransferTarget } from '../engine/intentParser';

export type ResolvedRecipient = {
  beneficiaryId?: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  bankName: string;
  accountType: string;
};

export type BankResolveResult =
  | { ok: true; resolved: ResolvedRecipient }
  | {
      ok: false;
      reason: 'unknown_bank' | 'invalid' | 'unavailable';
    };

type NgBank = { code: string; name: string };

/** Alias groups so "OPay" matches Flutterwave "Paycom" / "Opay". */
const BANK_ALIASES: string[][] = [
  ['opay', 'paycom', 'o pay'],
  ['palmpay', 'palm pay'],
  ['gtbank', 'guaranty trust', 'gtb'],
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
];

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeBankLabel(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasGroupForHint(hint: string): string[] | null {
  const h = normalizeBankLabel(hint);
  if (!h) return null;
  return (
    BANK_ALIASES.find((group) =>
      group.some((alias) => h === alias || h.includes(alias) || alias.includes(h))
    ) ?? null
  );
}

/**
 * Rank Flutterwave banks for a user bank hint (e.g. "OPay").
 * Prefer exact / substring name matches, then alias-group matches.
 * Avoid matching very short bank names via `hint.includes(name)`.
 */
export function rankBanksForHint(
  banks: NgBank[],
  bankHint: string
): NgBank[] {
  const hint = normalizeBankLabel(bankHint);
  if (!hint) return [];

  const aliases = aliasGroupForHint(hint);
  const scored: Array<{ bank: NgBank; score: number }> = [];

  for (const bank of banks) {
    const name = normalizeBankLabel(bank.name);
    if (!name) continue;

    let score = 0;
    if (name === hint) score = 100;
    else if (name.includes(hint)) score = 90;
    else if (hint.length >= 4 && name.length >= 4 && hint.includes(name)) {
      score = 75;
    } else if (
      aliases &&
      aliases.some((alias) => name.includes(alias) || alias.includes(name))
    ) {
      score = 70;
    } else {
      continue;
    }

    // Prefer Flutterwave "Opay" (100004) over "Paycom" (305) when both match.
    if (/^opay$/.test(name) || name.startsWith('opay ')) score += 5;

    scored.push({ bank, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: NgBank[] = [];
  for (const row of scored) {
    const key = String(row.bank.code);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.bank);
  }
  return out;
}

function maskAccount(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••${digits.slice(-4)}`;
}

export function formatRecipientLine(recipient: ResolvedRecipient): string {
  const bank = recipient.bankName || 'Bank';
  return `${recipient.name} — ${bank} ${maskAccount(recipient.accountNumber)}`;
}

export async function resolveRecipientByName(
  userId: string,
  name: string
): Promise<ResolvedRecipient | null> {
  const query = normalizeName(name);
  if (!query) return null;

  const { recipients } = await listSavedRecipients(userId, 100, 0);

  const exact = recipients.filter(
    (r) => normalizeName(r.beneficiary.name) === query
  );
  const partial = recipients.filter((r) =>
    normalizeName(r.beneficiary.name).includes(query)
  );

  const matches = exact.length ? exact : partial;
  if (matches.length !== 1) return null;

  const row = matches[0];
  if (row.beneficiary.accountType !== 'bank') return null;

  return {
    beneficiaryId: row.beneficiary.id,
    name: row.beneficiary.name,
    accountNumber: row.beneficiary.accountNumber,
    bankCode: row.source.networkId,
    bankName: row.source.networkId,
    accountType: row.beneficiary.accountType,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bankResolveKind(
  err: unknown
): 'invalid' | 'unavailable' {
  const typed = err as { bankResolveKind?: string; flutterwaveMessage?: string };
  if (typed?.bankResolveKind === 'invalid') return 'invalid';
  if (typed?.bankResolveKind === 'unavailable') return 'unavailable';
  const msg = String(typed?.flutterwaveMessage || (err as Error)?.message || '');
  if (/invalid account|account number|could not be found|does not exist/i.test(msg)) {
    return 'invalid';
  }
  return 'unavailable';
}

async function resolveAccountWithRetries(
  paymentService: PaymentService,
  accountNumber: string,
  bank: NgBank
): Promise<
  | {
      ok: true;
      accountName: string;
      accountNumber: string;
      bankCode: string;
      bankName: string;
    }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  let lastKind: 'invalid' | 'unavailable' = 'unavailable';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resolved = await paymentService.resolveBankAccount(
        accountNumber,
        bank.code
      );
      if (!resolved?.accountName) {
        return { ok: false, kind: 'invalid' };
      }
      return {
        ok: true,
        accountName: String(resolved.accountName),
        accountNumber: String(resolved.accountNumber ?? accountNumber),
        bankCode: bank.code,
        bankName: bank.name,
      };
    } catch (err) {
      lastKind = bankResolveKind(err);
      console.warn(
        `[four/bank] resolve failed bank=${bank.name} code=${bank.code} kind=${lastKind} attempt=${attempt + 1}`
      );
      if (lastKind === 'invalid') {
        return { ok: false, kind: 'invalid' };
      }
      if (attempt === 0) await sleep(450);
    }
  }

  return { ok: false, kind: lastKind };
}

/**
 * Resolve a Nigerian bank account from a hint like "OPay" + NUBAN.
 * Tries alias-ranked bank codes and retries transient Flutterwave failures.
 */
export async function resolveBankRecipient(
  _userId: string,
  target: BankTransferTarget
): Promise<BankResolveResult> {
  const paymentService = new PaymentService();
  const { banks } = await paymentService.fetchBanks();
  const candidates = rankBanksForHint(banks as NgBank[], target.bankHint);

  if (!candidates.length) {
    return { ok: false, reason: 'unknown_bank' };
  }

  let sawUnavailable = false;
  let sawInvalid = false;

  // Try top candidate codes (OPay often has both 100004 and 305).
  for (const bank of candidates.slice(0, 3)) {
    const result = await resolveAccountWithRetries(
      paymentService,
      target.accountNumber,
      bank
    );
    if (result.ok) {
      return {
        ok: true,
        resolved: {
          name: result.accountName,
          accountNumber: result.accountNumber,
          bankCode: result.bankCode,
          bankName: result.bankName,
          accountType: 'bank',
        },
      };
    }
    if (result.kind === 'unavailable') sawUnavailable = true;
    else sawInvalid = true;
  }

  if (sawUnavailable) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: false, reason: sawInvalid ? 'invalid' : 'unavailable' };
}

export async function resolveBankName(bankCode: string): Promise<string> {
  try {
    const PaymentService = (await import('../../payment/services')).default;
    const service = new PaymentService();
    const { banks } = await service.fetchBanks();
    const match = (banks as Array<{ code: string; name: string }>).find(
      (b) => String(b.code) === String(bankCode)
    );
    return match?.name ?? bankCode;
  } catch {
    return bankCode;
  }
}
