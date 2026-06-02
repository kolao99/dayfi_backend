import crypto from 'crypto';
import { db } from '../../config/database';

export type SaveRecipientInput = {
  name: string;
  country: string;
  phone?: string;
  ledgerCurrency: string;
  source: {
    accountType: string;
    accountNumber: string;
    networkId?: string;
  };
};

export type SavedRecipientRow = {
  beneficiary: {
    id: string;
    name: string;
    country: string;
    phone: string;
    address: string;
    dob: string;
    email: string;
    idNumber: string;
    idType: string;
    accountNumber: string;
    accountType: string;
  };
  source: {
    id: string;
    accountType: string;
    accountNumber: string;
    networkId: string;
    beneficiaryId: string;
  };
  ledgerCurrency: string;
};

function normalizeAccountType(type: string): string {
  const t = type.trim().toLowerCase();
  switch (t) {
    case 'bank':
    case 'bank_transfer':
    case 'eft':
    case 'p2p':
    case 'peer_to_peer':
    case 'peer-to-peer':
      return 'bank';
    case 'dayfi':
    case 'dayfi_tag':
      return 'dayfi';
    case 'crypto':
    case 'cryptocurrency':
      return 'crypto';
    case 'phone':
    case 'mobile':
    case 'mobile_money':
    case 'momo':
    case 'mobilemoney':
      return 'mobile_money';
    default:
      return t;
  }
}

function mapRow(
  b: Record<string, unknown>,
  s: Record<string, unknown>
): SavedRecipientRow {
  const accountType = normalizeAccountType(String(s.account_type ?? ''));
  const accountNumber = String(s.account_number ?? '').trim();
  return {
    beneficiary: {
      id: String(b.id),
      name: String(b.name ?? ''),
      country: String(b.country ?? ''),
      phone: String(b.phone ?? ''),
      address: String(b.address ?? ''),
      dob: String(b.dob ?? ''),
      email: String(b.email ?? ''),
      idNumber: String(b.id_number ?? ''),
      idType: String(b.id_type ?? ''),
      accountNumber,
      accountType,
    },
    source: {
      id: String(s.id),
      accountType,
      accountNumber,
      networkId: String(s.network_id ?? ''),
      beneficiaryId: String(s.beneficiary_id ?? b.id),
    },
    ledgerCurrency: String(s.ledger_currency ?? 'NGN').toUpperCase(),
  };
}

export async function upsertSavedRecipient(
  userId: string,
  input: SaveRecipientInput
): Promise<SavedRecipientRow> {
  const accountType = normalizeAccountType(String(input.source.accountType));
  const accountNumber = String(input.source.accountNumber).trim();
  const networkId = String(input.source.networkId ?? '').trim();
  const ledgerCurrency = String(input.ledgerCurrency).trim().toUpperCase();
  const name = String(input.name).trim();
  const country = String(input.country).trim().toUpperCase();
  const phone = String(input.phone ?? '').trim();

  if (!name || !accountNumber || !accountType) {
    throw new Error('Recipient name and account details are required');
  }
  if (accountType === 'dayflow') {
    throw new Error('Invalid recipient type');
  }

  const existing = await db.oneOrNone<{
    beneficiary_id: string;
    source_id: string;
  }>(
    `SELECT b.id AS beneficiary_id, s.id AS source_id
     FROM beneficiaries b
     INNER JOIN source s ON s.beneficiary_id = b.id
     WHERE b.user_id = $1
       AND b.saved_manually = TRUE
       AND (
         ($2 = 'mobile_money' AND LOWER(s.account_type) IN ('mobile_money', 'phone', 'mobile', 'momo', 'mobilemoney'))
         OR ($2 != 'mobile_money' AND LOWER(s.account_type) = $2)
       )
       AND LOWER(TRIM(s.account_number)) = LOWER($3)
       AND COALESCE(s.network_id, '') = $4
       AND COALESCE(UPPER(s.ledger_currency), '') = $5
     LIMIT 1`,
    [userId, accountType, accountNumber, networkId, ledgerCurrency]
  );

  if (existing) {
    await db.none(
      `UPDATE beneficiaries
       SET name = $2, country = $3, phone = $4
       WHERE id = $1 AND user_id = $5`,
      [existing.beneficiary_id, name, country, phone, userId]
    );
    await db.none(
      `UPDATE source SET account_type = $2 WHERE id = $1`,
      [existing.source_id, accountType]
    );
    const row = await db.one<Record<string, unknown>>(
      `SELECT b.*, s.id AS source_row_id, s.account_type, s.account_number,
              s.network_id, s.beneficiary_id, s.ledger_currency
       FROM beneficiaries b
       INNER JOIN source s ON s.beneficiary_id = b.id
       WHERE b.id = $1`,
      [existing.beneficiary_id]
    );
    return mapRow(row, {
      id: row.source_row_id,
      account_type: row.account_type,
      account_number: row.account_number,
      network_id: row.network_id,
      beneficiary_id: row.beneficiary_id,
      ledger_currency: row.ledger_currency,
    });
  }

  const beneficiaryId = `ben-saved-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const sourceId = `src-saved-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

  await db.none(
    `INSERT INTO beneficiaries (
      id, user_id, name, country, phone, address, dob, email, id_number, id_type, saved_manually
    ) VALUES ($1, $2, $3, $4, $5, '', '', '', '', 'individual', TRUE)`,
    [beneficiaryId, userId, name, country, phone]
  );

  await db.none(
    `INSERT INTO source (
      id, account_type, account_number, network_id, beneficiary_id, ledger_currency
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sourceId, accountType, accountNumber, networkId, beneficiaryId, ledgerCurrency]
  );

  const created = await db.one<Record<string, unknown>>(
    `SELECT b.*, s.id AS source_row_id, s.account_type, s.account_number,
            s.network_id, s.beneficiary_id, s.ledger_currency
     FROM beneficiaries b
     INNER JOIN source s ON s.beneficiary_id = b.id
     WHERE b.id = $1`,
    [beneficiaryId]
  );

  return mapRow(created, {
    id: created.source_row_id,
    account_type: created.account_type,
    account_number: created.account_number,
    network_id: created.network_id,
    beneficiary_id: created.beneficiary_id,
    ledger_currency: created.ledger_currency,
  });
}

export async function listSavedRecipients(
  userId: string,
  limit: number,
  offset: number
): Promise<{
  recipients: SavedRecipientRow[];
  totalCount: number;
  totalPages: number;
  page: number;
  limit: number;
}> {
  const rows = await db.any<Record<string, unknown>>(
    `SELECT b.*, s.id AS source_row_id, s.account_type, s.account_number,
            s.network_id, s.beneficiary_id, s.ledger_currency
     FROM beneficiaries b
     INNER JOIN source s ON s.beneficiary_id = b.id
     WHERE b.user_id = $1
       AND b.saved_manually = TRUE
       AND LOWER(COALESCE(s.account_type, '')) != 'dayflow'
       AND LOWER(TRIM(b.name)) != 'dayflow'
     ORDER BY b.name ASC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countRow = await db.one<{ total: string }>(
    `SELECT COUNT(*) AS total
     FROM beneficiaries b
     INNER JOIN source s ON s.beneficiary_id = b.id
     WHERE b.user_id = $1
       AND b.saved_manually = TRUE
       AND LOWER(COALESCE(s.account_type, '')) != 'dayflow'
       AND LOWER(TRIM(b.name)) != 'dayflow'`,
    [userId]
  );

  const totalCount = Number(countRow.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const page = Math.max(1, Math.floor(offset / limit) + 1);

  const recipients = rows.map((row) =>
    mapRow(row, {
      id: row.source_row_id,
      account_type: row.account_type,
      account_number: row.account_number,
      network_id: row.network_id,
      beneficiary_id: row.beneficiary_id,
      ledger_currency: row.ledger_currency,
    })
  );

  return { recipients, totalCount, totalPages, page, limit };
}
