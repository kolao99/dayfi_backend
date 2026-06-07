import { db } from '../../config/database';
import { normalizeRecipientPhone } from './recipientPhone';

export type YellowCardRetailSender = {
  name: string;
  email: string;
  phone: string;
  country: string;
  address: string;
  dob: string;
  idNumber: string;
  idType: string;
  additionalIdType?: string;
  additionalIdNumber?: string;
};

export type YellowCardSendPartyFields = {
  customerType: 'retail';
  customerUID: string;
  sender: YellowCardRetailSender;
};

type UserKycRow = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  phone_number: string | null;
  country: string | null;
  address: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  date_of_birth: string | null;
  bvn: string | null;
  id_type: string | null;
  id_number: string | null;
};

function formatYellowCardDob(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '01/01/1990';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmy) return s;
  return '01/01/1990';
}

function resolveUserAddress(row: UserKycRow): string {
  const direct = String(row.address ?? '').trim();
  if (direct.length >= 5) return direct;

  const parts = [
    row.street,
    row.city,
    row.state,
    row.country,
  ]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(', ');

  return 'Lagos, Nigeria';
}

function resolveNigeriaIds(row: UserKycRow): {
  nin: string;
  bvn: string;
  idType: string;
  idNumber: string;
  additionalIdType?: string;
  additionalIdNumber?: string;
} {
  const bvn = String(row.bvn ?? '').trim();
  const idTypeRaw = String(row.id_type ?? '').trim().toUpperCase();
  const idNumber = String(row.id_number ?? '').trim();

  let nin = '';
  if (idTypeRaw.includes('NIN') && /^\d{11}$/.test(idNumber)) {
    nin = idNumber;
  } else if (/^\d{11}$/.test(idNumber) && idTypeRaw !== 'BVN') {
    nin = idNumber;
  }

  const validBvn = /^\d{11}$/.test(bvn) ? bvn : '';
  const validNin = /^\d{11}$/.test(nin) ? nin : '';

  return {
    nin: validNin,
    bvn: validBvn,
    idType: validNin ? 'NIN' : 'passport',
    idNumber: validNin || idNumber || 'A00000000',
    ...(validBvn
      ? { additionalIdType: 'BVN', additionalIdNumber: validBvn }
      : {}),
  };
}

function resolveSenderCountry(row: UserKycRow): string {
  const raw = String(row.country ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  if (/^\d{11}$/.test(String(row.bvn ?? '').trim())) return 'NG';
  return 'NG';
}

export async function loadYellowCardRetailSender(
  userId: string
): Promise<YellowCardRetailSender> {
  const row = await db.oneOrNone<UserKycRow>(
    `SELECT user_id, email, first_name, last_name, middle_name, phone_number,
            country, address, street, city, state, date_of_birth, bvn, id_type, id_number
     FROM users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );

  if (!row) {
    throw new Error('User profile not found');
  }

  const firstName = String(row.first_name ?? '').trim();
  const lastName = String(row.last_name ?? '').trim();
  const country = resolveSenderCountry(row);
  const ids = resolveNigeriaIds(row);

  const name = [firstName, lastName]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');

  return {
    name: name || 'DayFi User',
    email: String(row.email ?? 'user@dayfi.co').trim() || 'user@dayfi.co',
    phone: normalizeRecipientPhone(row.phone_number, country),
    country,
    address: resolveUserAddress(row),
    dob: formatYellowCardDob(row.date_of_birth),
    idType: ids.idType,
    idNumber: ids.idNumber,
    ...(country === 'NG' && ids.additionalIdType
      ? {
          additionalIdType: ids.additionalIdType,
          additionalIdNumber: ids.additionalIdNumber,
        }
      : {}),
  };
}

export async function buildYellowCardSendPartyFields(
  userId: string
): Promise<YellowCardSendPartyFields> {
  const sender = await loadYellowCardRetailSender(userId);
  return {
    customerType: 'retail',
    customerUID: userId,
    sender,
  };
}

