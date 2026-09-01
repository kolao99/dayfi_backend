import { listSavedRecipients } from '../../payment/savedRecipientService';

export type ResolvedRecipient = {
  beneficiaryId: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  bankName: string;
  accountType: string;
};

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
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
