import axios, { AxiosResponse } from 'axios';
import config from '../../config/env';

interface TransactionMetadata {
  callbackUrl?: string;
  [key: string]: any;
}

interface TransferRecipientResponse {
  status: boolean;
  message: string;
  data: any;
}

export const initializeTransaction = async (
  amount: number,
  currency: string,
  email: string,
  metadata: TransactionMetadata = {},
  splitCode: string
): Promise<any> => {
  const callbackUrl = metadata.callbackUrl || 'https://example.com/';
  try {
    return await axios.post(
      `${config?.PAYSTACK_URL}/transaction/initialize`,
      {
        email,
        amount: amount * 100,
        currency,
        callback_url: callbackUrl,
        metadata,
        split_code: splitCode,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
        },
      }
    );
  } catch (err) {
    console.log(err);
  }
};

export const verifyTransaction = async (
  reference: string
): Promise<AxiosResponse> => {
  const url = new URL(`/transaction/verify/${reference}`, config?.PAYSTACK_URL);
  return axios.get(url.toString(), {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
    },
  });
};

export const resolveAccount = async (
  accountNumber: string,
  bankCode: string
): Promise<AxiosResponse> => {
  return axios.get(`${config?.PAYSTACK_URL}/bank/resolve`, {
    params: { account_number: accountNumber, bank_code: bankCode },
    headers: {
      Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
  });
};

export const fetchBanks = async (): Promise<AxiosResponse> => {
  return axios.get(`${config?.PAYSTACK_URL}/bank`, {
    headers: {
      Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
  });
};

export const createTransferRecipient = async (
  accountNumber: string,
  bankCode: string,
  recipientName: string
): Promise<TransferRecipientResponse> => {
  const response = await axios.post(
    `${config?.PAYSTACK_URL}/transferrecipient`,
    {
      type: 'nuban',
      name: recipientName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    },
    {
      headers: {
        Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
};

export const initiateTransfer = async (
  amount: number,
  recipientCode: string
): Promise<AxiosResponse> => {
  return await axios.post(
    `${config?.PAYSTACK_URL}/transfer`,
    {
      source: 'balance',
      amount: amount * 100,
      currency: 'NGN',
      recipient: recipientCode,
    },
    {
      headers: {
        Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
};

export const createCustomer = async (
  email: string,
  firstName: string,
  lastName: string,
  phone: string
): Promise<AxiosResponse> => {
  return await axios.post(
    `${config?.PAYSTACK_URL}/customer`,
    {
      email,
      first_name: firstName,
      last_name: lastName,
      phone,
    },
    {
      headers: {
        Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
};

export const createDedicatedAccount = async (
  customerCode: string,
  preferredBank?: string
): Promise<AxiosResponse> => {
  const payload: any = {
    customer: customerCode,
  };

  if (preferredBank) {
    payload.preferred_bank = preferredBank;
  }

  return await axios.post(
    `${config?.PAYSTACK_URL}/dedicated_account`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
};
//
// export const createTransferRecipient = async (
//   name: string,
//   accountNumber: string,
//   bankCode: string,
//   currency = 'NGN'
// ): Promise<{ recipientCode: string; response: any }> => {
//   try {
//     const response = await axios.post(
//       `${config?.PAYSTACK_URL}/transferrecipient`,
//       {
//         type: 'nuban',
//         name,
//         account_number: accountNumber,
//         bank_code: bankCode,
//         currency,
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${config?.PAYSTACK_SECRET_KEY}`,
//           'Content-Type': 'application/json',
//         },
//       }
//     );
//
//     return {
//       recipientCode: response.data.data.recipient_code,
//       response: response.data,
//     };
//   } catch (error: any) {
//     console.error(
//       'Error creating transfer recipient:',
//       error?.response?.data || error.message
//     );
//     throw new Error('Failed to create transfer recipient on Paystack');
//   }
// };
