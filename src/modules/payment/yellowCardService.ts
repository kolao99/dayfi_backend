import crypto from 'crypto';
import axios from 'axios';
import config from '../../config/env';

export class YellowCardService {
  private apiKey = config?.YELLOWCARD_API_KEY as string;
  private apiSecret = config?.YELLOWCARD_API_SECRET as string;
  private baseUrl = config?.YELLOWCARD_BASE_URL as string;

  /** True when sandbox/production Yellow Card credentials are present. */
  isConfigured(): boolean {
    return Boolean(
      String(this.apiKey ?? '').trim() &&
        String(this.apiSecret ?? '').trim() &&
        String(this.baseUrl ?? '').trim()
    );
  }

  private generateSignature(
    timestamp: string,
    path: string,
    method: string,
    body?: any
  ): string {
    if (!this.apiSecret) {
      throw new Error('Yellow Card API secret key is not configured');
    }

    const hmac = crypto.createHmac('sha256', this.apiSecret);

    hmac.update(timestamp, 'utf8');
    hmac.update(path, 'utf8');
    hmac.update(method.toUpperCase(), 'utf8');

    if (body) {
      const bodyHash = crypto
        .createHash('sha256')
        .update(body)
        .digest('base64');

      hmac.update(bodyHash, 'utf8');
    }

    return hmac.digest('base64');
  }

  private getHeaders(method: string, path: string, body?: any) {
    if (!this.apiKey) {
      throw new Error('Yellow Card API key is not configured');
    }

    console.log(path, method, body);
    const timestamp = new Date().toISOString();
    const signature = this.generateSignature(timestamp, path, method, body);

    return {
      'X-YC-Timestamp': timestamp,
      Authorization: `YcHmacV1 ${this.apiKey}:${signature}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async fetchChannels(): Promise<any> {
    const path = '/business/channels';
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(`${this.baseUrl}${path}`, { headers });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error fetching Yellow Card channels:',
        error.response?.data || error.message
      );
      throw new Error(
        'Unable to fetch Yellow Card channels at this time. Please try again.'
      );
    }
  }

  async fetchNetworks(): Promise<any> {
    const path = '/business/networks';
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(`${this.baseUrl}${path}`, { headers });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error fetching Yellow Card networks:',
        error.response?.data || error.message
      );
      throw new Error(
        'Unable to fetch Yellow Card networks at this time. Please try again.'
      );
    }
  }

  async fetchExchangeRates(currency: string): Promise<any> {
    const path = `/business/rates?currency=${currency}`;
    const method = 'GET';
    const headers = this.getHeaders(method, '/business/rates');

    try {
      const response = await axios.get(`${this.baseUrl}${path}`, { headers });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error fetching Yellow Card exchange rates:',
        error.response?.data || error.message
      );
      throw new Error(
        'Unable to fetch Yellow Card exchange rates at this time. Please try again.'
      );
    }
  }

  async createCollectionRequest(payload: Record<string, any>): Promise<any> {
    const path = '/business/collections';
    const method = 'POST';
    const body = JSON.stringify(payload);
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.post(`${this.baseUrl}${path}`, payload, {
        headers,
      });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error creating Yellow Card collection request:',
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message ||
          'Unable to create Yellow Card collection request at this time. Please try again.'
      );
    }
  }

  async createPaymentRequest(payload: Record<string, any>): Promise<any> {
    const path = '/business/payments';
    const method = 'POST';
    const body = JSON.stringify(payload);
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.post(`${this.baseUrl}${path}`, payload, {
        headers,
      });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error creating Yellow Card payment request:',
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message ||
          'Unable to create Yellow Card payment request at this time. Please try again.'
      );
    }
  }

  async resolveBankDetailsYC(
    accountNumber: string,
    networkId: string
  ): Promise<any> {
    const path = '/business/details/bank';
    const method = 'POST';
    const body = JSON.stringify({ accountNumber, networkId });
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.post(
        `${this.baseUrl}${path}`,
        { accountNumber, networkId },
        { headers }
      );
      return response.data;
    } catch (error: any) {
      console.error(
        'Error resolving Yellow Card bank account:',
        error.response?.data || error.message
      );
      throw new Error(
        'Unable to verify Yellow Card account details at this time. Please try again.'
      );
    }
  }

  async createWebhook(url: string, state: string): Promise<any> {
    const path = '/business/webhooks';
    const method = 'POST';
    const body = JSON.stringify({ url, state });
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.post(
        `${this.baseUrl}${path}`,
        { url, state },
        { headers }
      );
      return response.data;
    } catch (error: any) {
      console.error(
        'Error creating Yellow Card webhook:',
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message ||
          'Unable to create Yellow Card webhook at this time. Please try again.'
      );
    }
  }

  async fetchWebhooks(): Promise<any> {
    const path = '/business/webhooks';
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(`${this.baseUrl}${path}`, { headers });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error fetching Yellow Card webhooks:',
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message ||
          'Unable to fetch Yellow Card webhooks at this time. Please try again.'
      );
    }
  }

  async updateWebhook(
    id: string,
    active: boolean,
    url: string,
    state: string
  ): Promise<any> {
    const path = `/business/webhooks/${id}`;
    const method = 'PUT';
    const body = JSON.stringify({ active, url, state });
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.put(
        `${this.baseUrl}${path}`,
        { active, url, state },
        { headers }
      );
      return response.data;
    } catch (error: any) {
      console.error(
        'Error updating Yellow Card webhook:',
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message ||
          'Unable to update Yellow Card webhook at this time. Please try again.'
      );
    }
  }

  async removeWebhook(id: string): Promise<any> {
    const path = `/business/webhooks/${id}`;
    const method = 'DELETE';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.delete(`${this.baseUrl}${path}`, {
        headers,
      });
      return response.data;
    } catch (error: any) {
      console.error(
        'Error removing Yellow Card webhook:',
        error.response?.data || error.message
      );
      throw new Error(
        error.response?.data?.message ||
          'Unable to remove Yellow Card webhook at this time. Please try again.'
      );
    }
  }
}

export default YellowCardService;
