import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import config from '../../config/env';

function normalizeBaseUrl(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

/** Normalize GET /business/channels body to a flat array for mobile `{ channels: [...] }`. */
export function parseYellowCardChannelList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((c) => c && typeof c === 'object') as Record<string, unknown>[];
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.channels)) {
      return o.channels.filter((c) => c && typeof c === 'object') as Record<
        string,
        unknown
      >[];
    }
    if (Array.isArray(o.data)) {
      return o.data.filter((c) => c && typeof c === 'object') as Record<
        string,
        unknown
      >[];
    }
  }
  return [];
}

function yellowCardAxiosDetail(err: unknown): string {
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const e = err as AxiosError<{ message?: string }>;
  const status = e.response?.status;
  const data = e.response?.data as unknown;
  let body = '';
  if (data != null && typeof data === 'object' && 'message' in data) {
    body = String((data as { message?: string }).message ?? '');
  } else if (typeof data === 'string') {
    body = data;
  } else if (data != null) {
    try {
      body = JSON.stringify(data);
    } catch {
      body = String(data);
    }
  }
  const parts = [
    status != null ? `HTTP ${status}` : null,
    body || e.message || null,
  ].filter(Boolean);
  return parts.join(' — ') || 'Unknown error';
}

export class YellowCardService {
  private apiKey = config?.YELLOWCARD_API_KEY as string;
  private apiSecret = config?.YELLOWCARD_API_SECRET as string;
  private baseUrl = normalizeBaseUrl(config?.YELLOWCARD_BASE_URL as string);

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

    if (process.env.DAYFI_YELLOWCARD_DEBUG === 'true') {
      console.log('[YellowCard]', method, path, body ? '(has body)' : '');
    }

    const timestamp = new Date().toISOString();
    const signature = this.generateSignature(timestamp, path, method, body);

    return {
      'X-YC-Timestamp': timestamp,
      Authorization: `YcHmacV1 ${this.apiKey}:${signature}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private url(path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${p}`;
  }

  async fetchChannels(): Promise<any> {
    const path = '/business/channels';
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(this.url(path), {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] fetchChannels:', detail);
      throw new Error(
        `Unable to fetch Yellow Card channels: ${detail}`.slice(0, 2000)
      );
    }
  }

  async fetchNetworks(): Promise<any> {
    const path = '/business/networks';
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(this.url(path), {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] fetchNetworks:', detail);
      throw new Error(
        `Unable to fetch Yellow Card networks: ${detail}`.slice(0, 2000)
      );
    }
  }

  /**
   * HMAC path must match the request path exactly (including query string).
   * Previously signed `/business/rates` while calling `/business/rates?currency=…`, which breaks auth.
   */
  async fetchExchangeRates(currency: string): Promise<any> {
    const safe = encodeURIComponent(String(currency ?? '').trim());
    const path = `/business/rates?currency=${safe}`;
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(this.url(path), {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] fetchExchangeRates:', detail);
      throw new Error(
        `Unable to fetch Yellow Card exchange rates: ${detail}`.slice(0, 2000)
      );
    }
  }

  async createCollectionRequest(payload: Record<string, any>): Promise<any> {
    const path = '/business/collections';
    const method = 'POST';
    const body = JSON.stringify(payload);
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.post(this.url(path), payload, {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] createCollectionRequest:', detail);
      throw new Error(
        error.response?.data?.message ||
          `Unable to create Yellow Card collection request: ${detail}`.slice(
            0,
            2000
          )
      );
    }
  }

  async createPaymentRequest(payload: Record<string, any>): Promise<any> {
    const path = '/business/payments';
    const method = 'POST';
    const body = JSON.stringify(payload);
    const headers = this.getHeaders(method, path, body);

    try {
      const response = await axios.post(this.url(path), payload, {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] createPaymentRequest:', detail);
      throw new Error(
        error.response?.data?.message ||
          `Unable to create Yellow Card payment request: ${detail}`.slice(
            0,
            2000
          )
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
        this.url(path),
        { accountNumber, networkId },
        { headers, timeout: 25_000 }
      );
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] resolveBankDetailsYC:', detail);
      throw new Error(
        `Unable to verify Yellow Card account details: ${detail}`.slice(0, 2000)
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
        this.url(path),
        { url, state },
        { headers, timeout: 25_000 }
      );
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] createWebhook:', detail);
      throw new Error(
        error.response?.data?.message ||
          `Unable to create Yellow Card webhook: ${detail}`.slice(0, 2000)
      );
    }
  }

  async fetchWebhooks(): Promise<any> {
    const path = '/business/webhooks';
    const method = 'GET';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.get(this.url(path), {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] fetchWebhooks:', detail);
      throw new Error(
        `Unable to fetch Yellow Card webhooks: ${detail}`.slice(0, 2000)
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
        this.url(path),
        { active, url, state },
        { headers, timeout: 25_000 }
      );
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] updateWebhook:', detail);
      throw new Error(
        error.response?.data?.message ||
          `Unable to update Yellow Card webhook: ${detail}`.slice(0, 2000)
      );
    }
  }

  async removeWebhook(id: string): Promise<any> {
    const path = `/business/webhooks/${id}`;
    const method = 'DELETE';
    const headers = this.getHeaders(method, path);

    try {
      const response = await axios.delete(this.url(path), {
        headers,
        timeout: 25_000,
      });
      return response.data;
    } catch (error: any) {
      const detail = yellowCardAxiosDetail(error);
      console.error('[YellowCard] removeWebhook:', detail);
      throw new Error(
        error.response?.data?.message ||
          `Unable to remove Yellow Card webhook: ${detail}`.slice(0, 2000)
      );
    }
  }
}

export default YellowCardService;
