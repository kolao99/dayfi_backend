import crypto from 'node:crypto';
import axios, { type AxiosInstance } from 'axios';
import { db } from '../../config/database';
import config from '../../config/env';

export type GreyAccountCurrency = 'USD' | 'EUR' | 'GBP' | 'NGN';

const CURRENCY_RAILS: Record<GreyAccountCurrency, string[]> = {
  USD: ['ACH', 'SWIFT', 'Fedwire'],
  EUR: ['SEPA'],
  GBP: ['FPS', 'CHAPS'],
  NGN: ['NIP', 'local'],
};

/**
 * Grey Business API — primary fiat rail (multi-currency accounts, collections, payouts).
 * Configure base URL from Grey dashboard → Integrations (sandbox vs production).
 *
 * @see https://sandbox.grey.co/dashboard (sandbox)
 */
export class GreyService {
  private apiKey = (config?.GREY_API_KEY as string | undefined)?.trim();
  private baseUrl = (config?.GREY_BASE_URL as string | undefined)?.replace(
    /\/$/,
    ''
  );
  private webhookSecret = (config?.GREY_WEBHOOK_SECRET as string | undefined)?.trim();
  private sandbox =
    (config?.GREY_SANDBOX as boolean | undefined) ??
    process.env.DAYFI_GREY_SANDBOX !== 'false';

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.baseUrl);
  }

  private client(): AxiosInstance {
    if (!this.isConfigured()) {
      throw new Error(
        'Grey is not configured. Set DAYFI_GREY_API_KEY and DAYFI_GREY_BASE_URL.'
      );
    }
    return axios.create({
      baseURL: this.baseUrl,
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  /** List stored Grey account metadata for a user. */
  async listVirtualAccounts(userId: string): Promise<Record<string, unknown>[]> {
    return db.any(
      `SELECT id, currency, account_name, account_number, bank_name, iban,
              routing_number, provider_reference, raw_metadata, created_at
       FROM grey_virtual_accounts WHERE user_id = $1 ORDER BY currency`,
      [userId]
    );
  }

  /**
   * Fetch accounts from Grey API (tries common path variants).
   * Returns raw provider payload for debugging when KYB is pending.
   */
  async fetchProviderAccounts(): Promise<unknown> {
    const http = this.client();
    const paths = [
      '/v1/accounts',
      '/accounts',
      '/v1/wallets',
      '/wallets',
    ];
    let lastErr: unknown;
    for (const path of paths) {
      try {
        const res = await http.get(path);
        return res.data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Unable to fetch accounts from Grey API');
  }

  /**
   * Ensure we have a row for receive UI; sync from Grey when API returns account details.
   */
  async ensureVirtualAccount(params: {
    userId: string;
    currency: GreyAccountCurrency;
    accountName: string;
  }): Promise<Record<string, unknown>> {
    const existing = await db.oneOrNone(
      `SELECT * FROM grey_virtual_accounts WHERE user_id = $1 AND currency = $2`,
      [params.userId, params.currency]
    );
    if (existing?.account_number || existing?.iban) {
      return existing;
    }

    let providerData: Record<string, unknown> | null = null;
    if (this.isConfigured()) {
      try {
        const raw = await this.fetchProviderAccounts();
        providerData = this.pickAccountForCurrency(raw, params.currency);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[Grey] fetchProviderAccounts:', msg);
      }
    }

    if (existing) {
      if (providerData) {
        return this.updateVirtualAccountRow(existing.id as string, providerData, params);
      }
      return existing;
    }

    return this.insertVirtualAccountRow(params, providerData);
  }

  private pickAccountForCurrency(
    raw: unknown,
    currency: GreyAccountCurrency
  ): Record<string, unknown> | null {
    const list = this.normalizeAccountList(raw);
    const match = list.find(
      (a) =>
        String(a.currency ?? a.code ?? '')
          .toUpperCase()
          .startsWith(currency) ||
        String(a.type ?? '').toUpperCase().includes(currency)
    );
    return match ?? list[0] ?? null;
  }

  private normalizeAccountList(raw: unknown): Record<string, unknown>[] {
    if (Array.isArray(raw)) return raw as Record<string, unknown>[];
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      for (const key of ['data', 'accounts', 'wallets', 'items', 'results']) {
        if (Array.isArray(o[key])) return o[key] as Record<string, unknown>[];
      }
    }
    return [];
  }

  private async insertVirtualAccountRow(
    params: {
      userId: string;
      currency: GreyAccountCurrency;
      accountName: string;
    },
    provider: Record<string, unknown> | null
  ): Promise<Record<string, unknown>> {
    const hasDetails = Boolean(
      provider?.account_number ??
        provider?.accountNumber ??
        provider?.iban
    );
    const kybStatus =
      hasDetails
        ? 'active'
        : params.currency === 'NGN'
          ? 'request_bank_account'
          : params.currency === 'USD'
            ? 'processing'
            : 'pending';

    const meta = {
      rails: CURRENCY_RAILS[params.currency],
      sandbox: this.sandbox,
      kybStatus,
      provider,
    };
    return db.one(
      `INSERT INTO grey_virtual_accounts (
         user_id, currency, account_name, account_number, bank_name, iban,
         routing_number, provider_reference, raw_metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        params.userId,
        params.currency,
        params.accountName,
        provider?.account_number ?? provider?.accountNumber ?? null,
        provider?.bank_name ?? provider?.bankName ?? null,
        provider?.iban ?? null,
        provider?.routing_number ?? provider?.routingNumber ?? null,
        provider?.id ?? provider?.reference ?? null,
        JSON.stringify(meta),
      ]
    );
  }

  private async updateVirtualAccountRow(
    rowId: string,
    provider: Record<string, unknown>,
    params: { accountName: string; currency: GreyAccountCurrency }
  ): Promise<Record<string, unknown>> {
    return db.one(
      `UPDATE grey_virtual_accounts SET
         account_name = $2,
         account_number = COALESCE($3, account_number),
         bank_name = COALESCE($4, bank_name),
         iban = COALESCE($5, iban),
         routing_number = COALESCE($6, routing_number),
         provider_reference = COALESCE($7, provider_reference),
         raw_metadata = raw_metadata || $8::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [
        rowId,
        params.accountName,
        provider.account_number ?? provider.accountNumber ?? null,
        provider.bank_name ?? provider.bankName ?? null,
        provider.iban ?? null,
        provider.routing_number ?? provider.routingNumber ?? null,
        provider.id ?? provider.reference ?? null,
        JSON.stringify({ provider, kybStatus: 'linked' }),
      ]
    );
  }

  verifyWebhookSignature(
    rawBody: string,
    signature: string | undefined
  ): boolean {
    if (!this.webhookSecret) {
      return process.env.NODE_ENV !== 'production';
    }
    if (!signature) return false;
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const normalized = signature.replace(/^sha256=/i, '').trim();
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(normalized)
      );
    } catch {
      return false;
    }
  }

  /**
   * Normalize Grey deposit / collection webhooks into ledger inflow fields.
   */
  parseCollectionWebhook(body: Record<string, unknown>): {
    userId: string;
    amount: number;
    currency: string;
    reference: string;
  } | null {
    const meta =
      body.metadata && typeof body.metadata === 'object'
        ? (body.metadata as Record<string, unknown>)
        : null;
    const userId = String(
      body.userId ??
        body.customerReference ??
        body.customer_id ??
        meta?.userId ??
        ''
    ).trim();

    const data =
      body.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : body;

    const amount = Number(
      data.amount ?? data.receivedAmount ?? body.amount ?? body.receivedAmount
    );
    const currency = String(
      data.currency ?? data.sourceCurrency ?? body.currency ?? 'USD'
    )
      .trim()
      .toUpperCase();
    const reference = String(
      data.reference ??
        data.transactionReference ??
        data.id ??
        body.reference ??
        body.id ??
        ''
    ).trim();

    if (!userId || !reference || !Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    return { userId, amount, currency, reference };
  }

  async ping(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.fetchProviderAccounts();
      return true;
    } catch {
      return false;
    }
  }
}

export default GreyService;
