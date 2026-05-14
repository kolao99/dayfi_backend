import axios, { AxiosResponse } from 'axios';
import md5 from 'md5';
import forge from 'node-forge';
import config from '../../config/env';

const headers = {
  // Authorization: `Bearer ${config?.FLUTTERWAVE_SECRET_KEY}`,
  'Content-Type': 'application/json',
};
export function getKey(seckey: string): string {
  const keymd5: string = md5(seckey);

  const keymd5last12: string = keymd5.slice(-12);

  const seckeyadjusted: string = seckey.replace('FLWSECK-', '');

  const seckeyadjustedfirst12: string = seckeyadjusted.slice(0, 12);

  return seckeyadjustedfirst12 + keymd5last12;
}

export function encryptPayload(
  payload: Record<string, any>,
  encryptionKey: string
): string {
  try {
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
    const encryptedBase64 = forge.util.encode64(encrypted.getBytes());

    console.log('Encrypted Payload:', encryptedBase64);
    return encryptedBase64;
  } catch (error: any) {
    console.error('Encryption Error:', error.message);
    throw error;
  }
}

export const chargeCard = async (chargeData: any): Promise<any> => {
  try {
    const secretKey = config?.FLUTTERWAVE_SECRET_KEY || 'SECRET_KEY';

    const encryptedPayload = encryptPayload(chargeData, secretKey);
    const clientData = {
      PBFPubKey: config?.FLUTTERWAVE_PUBLIC_KEY,
      client: encryptedPayload,
      alg: '3DES-24',
    };

    const response = await axios.post(
      `${config?.FLUTTERWAVE_BASE_URL}/flwv3-pug/getpaidx/api/charge`,
      clientData,
      { headers: { 'Content-Type': 'application/json' } }
    );

    return response.data;
  } catch (error) {
    console.error(
      'Error charging card:',
      error.response?.data || error.message
    );
    throw error;
  }
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
  const url = 'https://api.ravepay.co/flwv3-pug/getpaidx/api/tokenized/charge';

  const data = {
    SECKEY: config?.FLUTTERWAVE_SECRET_KEY,
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

  try {
    const response = await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data;
  } catch (error) {
    throw error;
  }
};

export const verifyCharge = async (
  transaction_reference: string,
  otp: string
): Promise<any> => {
  const url = `${config?.FLUTTERWAVE_BASE_URL}/flwv3-pug/getpaidx/api/validatecharge`;

  const data = {
    PBFPubKey: config?.FLUTTERWAVE_PUBLIC_KEY,
    transaction_reference,
    otp,
  };

  try {
    const response = await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data;
  } catch (error: any) {
    console.error(
      'Error verifying charge:',
      error.response?.data || error.message
    );
    throw error;
  }
};

export const verifyPayment = async (txref: string): Promise<any> => {
  const url = `${config?.FLUTTERWAVE_BASE_URL}/flwv3-pug/getpaidx/api/v2/verify`;
  const data = {
    txref,
    SECKEY: config?.FLUTTERWAVE_SECRET_KEY,
  };

  try {
    const response = await axios.post(url, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(response);
    return response.data;
  } catch (error) {
    console.log(error);
    throw error;
  }
};

export const resolveBankDetails = async (
  accountNumber: string,
  bankCode: string
): Promise<AxiosResponse> => {
  try {
    return await axios.post(
      `https://api.flutterwave.com/v3/accounts/resolve`,
      {
        account_number: accountNumber,
        account_bank: bankCode,
      },
      {
        headers: {
          Authorization: `Bearer ${config?.FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error resolving bank details:', error);
    throw error;
  }
};

export const fetchBanks = async (): Promise<any> => {
  try {
    return await axios.get(
      `${config?.FLUTTERWAVE_BASE_URL}/flwv3-pug/getpaidx/api/flwpbf-banks.js?json=1&public_key=${config?.FLUTTERWAVE_PUBLIC_KEY}`,
      {
        headers,
      }
    );
  } catch (e) {
    console.log('Error fetchBanks', e);
    throw e;
  }
};

export const createVirtualAccount = async (
  email: string,
  bvn: string
): Promise<AxiosResponse> => {
  try {
    return await axios.post(
      `${config?.FLUTTERWAVE_BASE_URL}/v2/banktransfers/accountnumbers`,
      {
        email,
        bvn,
        is_permanent: true,
        narration: 'Your custom narration',
        tx_ref: `vaccount-${Date.now()}`,
        seckey: config?.FLUTTERWAVE_SECRET_KEY,
      },
      { headers }
    );
  } catch (e) {
    console.log('Error createVirtualAccount', e);
    throw e;
  }
};

export const initiateTransfer = async (
  account_bank: string,
  account_number: string,
  amount: number,
  narration: string,
  currency = 'NGN',
  reference: string,
  beneficiary_name: string,
  meta = {}
): Promise<AxiosResponse> => {
  const url = `${config?.FLUTTERWAVE_BASE_URL}/v2/gpx/transfers/create`;
  const data = {
    meta,
    account_bank,
    account_number,
    amount,
    seckey: config?.FLUTTERWAVE_SECRET_KEY,
    narration,
    currency,
    reference,
    beneficiary_name,
  };

  try {
    const response = await axios.post(url, data, { headers });

    if (response.data.status === 'success') {
      return response.data.data;
    } else {
      throw new Error(`Transfer failed: ${response.data.message}`);
    }
  } catch (error) {
    throw error;
  }
};
