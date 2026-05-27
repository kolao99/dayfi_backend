import axios, { AxiosResponse } from 'axios';
import md5 from 'md5';
import forge from 'node-forge';
import config from '../../config/env';

const FLW_V3_BASE = 'https://api.flutterwave.com';

function baseUrl(): string {
  const fromConfig = String(config?.FLUTTERWAVE_BASE_URL || '').trim();
  return fromConfig.replace(/\/+$/, '') || FLW_V3_BASE;
}

function secretKey(): string {
  const key = String(config?.FLUTTERWAVE_SECRET_KEY || '').trim();
  if (!key) {
    throw new Error('Flutterwave secret key is not configured (DAYFI_FLUTTERWAVE_SECRET_KEY)');
  }
  return key;
}

export function flutterwaveBaseUrl(): string {
  return baseUrl();
}

export function flutterwaveV3Headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Prod merchants often lack BVN lookup until Flutterwave enables it on the dashboard. */
export function isFlutterwaveBvnServiceUnavailable(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('not enabled to use bvn') ||
    (m.includes('bvn service') && m.includes('not enabled'))
  );
}

function v3Headers(): Record<string, string> {
  return flutterwaveV3Headers();
}

function unwrapData<T = Record<string, unknown>>(payload: unknown): T {
  const root = payload as Record<string, unknown>;
  const data = root?.data;
  if (data && typeof data === 'object') return data as T;
  return root as T;
}

export function getKey(seckey: string): string {
  const keymd5: string = md5(seckey);
  const keymd5last12: string = keymd5.slice(-12);
  const seckeyadjusted: string = seckey.replace('FLWSECK-', '');
  const seckeyadjustedfirst12: string = seckeyadjusted.slice(0, 12);
  return seckeyadjustedfirst12 + keymd5last12;
}

export function encryptPayload(
  payload: Record<string, unknown>,
  encryptionKey: string
): string {
  const cardDetails = JSON.stringify(payload);
  const key = getKey(encryptionKey);
  const cipher = forge.cipher.createCipher(
    '3DES-ECB',
    forge.util.createBuffer(key)
  );
  cipher.start({ iv: '' });
  // @ts-ignore
  cipher.update(forge.util.createBuffer(cardDetails, 'utf-8'));
  cipher.finish();
  const encrypted = cipher.output;
  return forge.util.encode64(encrypted.getBytes());
}

export const chargeCard = async (chargeData: Record<string, unknown>): Promise<any> => {
  const secret = secretKey();
  const encryptedPayload = encryptPayload(chargeData, secret);
  const clientData = {
    PBFPubKey: config?.FLUTTERWAVE_PUBLIC_KEY,
    client: encryptedPayload,
    alg: '3DES-24',
  };

  const response = await axios.post(
    `${baseUrl()}/flwv3-pug/getpaidx/api/charge`,
    clientData,
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data;
};

export const chargeCardWithToken = async (
  token: string,
  amount: number,
  currency: string,
  country = 'NG',
  email: string,
  firstname: string,
  lastname: string,
  IP: string,
  narration: string
): Promise<any> => {
  const data = {
    SECKEY: secretKey(),
    token,
    currency,
    country,
    amount,
    email,
    firstname,
    lastname,
    IP,
    narration,
    txRef: `trans-${Date.now()}`,
    meta: '',
  };

  const response = await axios.post(
    `${baseUrl()}/flwv3-pug/getpaidx/api/tokenized/charge`,
    data,
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data;
};

export const verifyCharge = async (
  transaction_reference: string,
  otp: string
): Promise<any> => {
  const data = {
    PBFPubKey: config?.FLUTTERWAVE_PUBLIC_KEY,
    transaction_reference,
    otp,
  };

  const response = await axios.post(
    `${baseUrl()}/flwv3-pug/getpaidx/api/validatecharge`,
    data,
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data;
};

export const verifyPayment = async (txref: string): Promise<any> => {
  const data = {
    txref,
    SECKEY: secretKey(),
  };

  const response = await axios.post(
    `${baseUrl()}/flwv3-pug/getpaidx/api/v2/verify`,
    data,
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data;
};

/** V3 account name enquiry (Nigeria). */
export const resolveBankDetails = async (
  accountNumber: string,
  bankCode: string
): Promise<AxiosResponse> => {
  return axios.post(
    `${baseUrl()}/v3/accounts/resolve`,
    {
      account_number: accountNumber,
      account_bank: bankCode,
    },
    { headers: v3Headers() }
  );
};

/** V3 Nigerian bank list for send / resolve UI. */
export const fetchBanks = async (): Promise<{
  banks: Array<{ id: string; code: string; name: string }>;
}> => {
  const response = await axios.get(`${baseUrl()}/v3/banks/NG`, {
    headers: v3Headers(),
  });
  const rows = unwrapData<unknown[]>(response.data) || [];
  const banks = (Array.isArray(rows) ? rows : []).map((row) => {
    const r = row as Record<string, unknown>;
    const code = String(r.code ?? r.id ?? '');
    return {
      id: code,
      code,
      name: String(r.name ?? ''),
    };
  });
  return { banks };
};

/** V3 permanent NGN virtual account (test + live). */
export const createVirtualAccount = async (
  email: string,
  bvn: string,
  options?: { firstname?: string; lastname?: string; phonenumber?: string }
): Promise<AxiosResponse> => {
  const txRef = `dayfi-va-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return axios.post(
    `${baseUrl()}/v3/virtual-account-numbers`,
    {
      email,
      bvn,
      is_permanent: true,
      tx_ref: txRef,
      narration: 'Dayfi NGN Wallet',
      currency: 'NGN',
      ...(options?.firstname ? { firstname: options.firstname } : {}),
      ...(options?.lastname ? { lastname: options.lastname } : {}),
      ...(options?.phonenumber ? { phonenumber: options.phonenumber } : {}),
    },
    { headers: v3Headers() }
  );
};

/** V3 bank transfer payout (debits Flutterwave balance). */
export const initiateTransfer = async (
  account_bank: string,
  account_number: string,
  amount: number,
  narration: string,
  currency = 'NGN',
  reference: string,
  beneficiary_name: string,
  meta: Record<string, unknown> = {}
): Promise<Record<string, unknown>> => {
  const response = await axios.post(
    `${baseUrl()}/v3/transfers`,
    {
      account_bank,
      account_number,
      amount,
      narration,
      currency,
      reference,
      beneficiary_name,
      meta,
    },
    { headers: v3Headers() }
  );

  const root = response.data as Record<string, unknown>;
  const status = String(root.status || '').toLowerCase();
  if (status !== 'success') {
    throw new Error(
      String(root.message || 'Flutterwave transfer failed')
    );
  }

  return unwrapData<Record<string, unknown>>(root);
};

function assertFlutterwaveSuccess(payload: unknown, fallback: string): unknown {
  const root = payload as Record<string, unknown>;
  const status = String(root?.status ?? '').toLowerCase();
  if (status !== 'success') {
    throw new Error(String(root?.message ?? fallback));
  }
  return root?.data ?? root;
}

/** Top Nigerian bill categories exposed in the Dayfi app. */
export const DAYFI_BILL_CATEGORY_CODES = [
  'AIRTIME',
  'MOBILEDATA',
  'CABLEBILLS',
  'INTSERVICE',
  'UTILITYBILLS',
] as const;

export async function fetchBillCategories(): Promise<unknown[]> {
  let response;
  try {
    response = await axios.get(`${baseUrl()}/v3/bill-categories`, {
      headers: v3Headers(),
    });
  } catch {
    response = await axios.get(`${baseUrl()}/v3/bills/categories`, {
      headers: v3Headers(),
    });
  }
  const data = assertFlutterwaveSuccess(
    response.data,
    'Failed to fetch bill categories'
  );
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((row) => {
    const r = row as Record<string, unknown>;
    const code = String(r.code ?? '').toUpperCase();
    return (DAYFI_BILL_CATEGORY_CODES as readonly string[]).includes(code);
  });
}

export async function fetchBillBillers(
  categoryCode: string,
  country = 'NG'
): Promise<unknown[]> {
  const category = String(categoryCode).toUpperCase();
  const response = await axios.get(
    `${baseUrl()}/v3/bills/${encodeURIComponent(category)}/billers`,
    { headers: v3Headers(), params: { country } }
  );
  const data = assertFlutterwaveSuccess(
    response.data,
    'Failed to fetch billers'
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchBillItems(billerCode: string): Promise<unknown[]> {
  const response = await axios.get(
    `${baseUrl()}/v3/billers/${encodeURIComponent(billerCode)}/items`,
    { headers: v3Headers() }
  );
  const data = assertFlutterwaveSuccess(response.data, 'Failed to fetch bill items');
  return Array.isArray(data) ? data : [];
}

export async function validateBillCustomer(params: {
  billerCode: string;
  itemCode: string;
  customerId: string;
}): Promise<Record<string, unknown>> {
  const response = await axios.post(
    `${baseUrl()}/v3/billers/${encodeURIComponent(params.billerCode)}/items/${encodeURIComponent(params.itemCode)}/validate`,
    { customer: params.customerId },
    { headers: v3Headers() }
  );
  const data = assertFlutterwaveSuccess(
    response.data,
    'Bill validation failed'
  );
  return (data ?? {}) as Record<string, unknown>;
}

export async function createBillPayment(params: {
  billerCode: string;
  itemCode: string;
  customerId: string;
  amount: number;
  reference: string;
  country?: string;
  callbackUrl?: string;
}): Promise<Record<string, unknown>> {
  const response = await axios.post(
    `${baseUrl()}/v3/billers/${encodeURIComponent(params.billerCode)}/items/${encodeURIComponent(params.itemCode)}/payment`,
    {
      country: params.country ?? 'NG',
      customer_id: params.customerId,
      amount: params.amount,
      reference: params.reference,
      ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
    },
    { headers: v3Headers() }
  );
  const data = assertFlutterwaveSuccess(
    response.data,
    'Bill payment failed'
  );
  return (data ?? {}) as Record<string, unknown>;
}

export async function fetchBillPaymentStatus(
  reference: string
): Promise<Record<string, unknown>> {
  const response = await axios.get(
    `${baseUrl()}/v3/bills/${encodeURIComponent(reference)}`,
    { headers: v3Headers() }
  );
  const data = assertFlutterwaveSuccess(
    response.data,
    'Failed to fetch bill status'
  );
  return (data ?? {}) as Record<string, unknown>;
}
