/**
 * Create + upload (+ try publish) Azap bill WhatsApp Flows.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/publish-azap-bill-flows.ts
 *
 * Prints META_WHATSAPP_FLOW_*_ID lines for .env / VPS.
 * Publish may fail with 139000 until Meta integrity clears — draft upload still succeeds.
 */
import axios from 'axios';
import FormData from 'form-data';
import type { BillCategoryCode } from '../src/modules/four/finance/billPaymentFlow';
import {
  AZAP_BILL_FLOW_JSON_BY_CATEGORY,
  AZAP_BILL_FLOW_NAMES,
} from '../src/modules/four/whatsapp/flows/billFlowJson';

const GRAPH_VERSION =
  String(process.env.META_WHATSAPP_GRAPH_VERSION || 'v21.0').trim() || 'v21.0';

function graphBase(): string {
  return `https://graph.facebook.com/${GRAPH_VERSION}`;
}

function accessToken(): string {
  const token = String(process.env.META_WHATSAPP_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('META_WHATSAPP_ACCESS_TOKEN is required');
  return token;
}

async function graphGet<T>(path: string): Promise<T> {
  const res = await axios.get(`${graphBase()}/${path.replace(/^\//, '')}`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const err = res.data?.error;
    throw new Error(
      err?.error_user_msg || err?.message || `GET ${path} → ${res.status}`
    );
  }
  return res.data as T;
}

async function graphPost<T>(
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await axios.post(
    `${graphBase()}/${path.replace(/^\//, '')}`,
    body ?? {},
    {
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );
  if (res.status >= 400) {
    const err = res.data?.error;
    throw new Error(
      err?.error_user_msg || err?.message || `POST ${path} → ${res.status}`
    );
  }
  return res.data as T;
}

async function listFlows(wabaId: string) {
  const data = await graphGet<{
    data?: Array<{ id: string; name: string; status?: string }>;
  }>(`${wabaId}/flows?fields=id,name,status&limit=100`);
  return data.data ?? [];
}

async function createFlow(wabaId: string, name: string): Promise<string> {
  const data = await graphPost<{ id: string }>(`${wabaId}/flows`, {
    name,
    categories: ['OTHER'],
  });
  if (!data.id) throw new Error('Flow create returned no id');
  return data.id;
}

async function uploadFlowJson(flowId: string, json: unknown): Promise<void> {
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', Buffer.from(JSON.stringify(json), 'utf8'), {
    filename: 'flow.json',
    contentType: 'application/json',
  });

  const res = await axios.post(`${graphBase()}/${flowId}/assets`, form, {
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    console.error(JSON.stringify(res.data, null, 2));
    throw new Error(
      res.data?.error?.error_user_msg ||
        res.data?.error?.message ||
        `Asset upload → ${res.status}`
    );
  }
  if (res.data?.validation_errors?.length) {
    console.error('Validation errors:', res.data.validation_errors);
    throw new Error('Flow JSON failed Meta validation');
  }
  console.log(`  uploaded OK`);
}

const ENV_KEYS: Record<BillCategoryCode, string> = {
  AIRTIME: 'META_WHATSAPP_FLOW_AIRTIME_ID',
  MOBILEDATA: 'META_WHATSAPP_FLOW_DATA_ID',
  UTILITYBILLS: 'META_WHATSAPP_FLOW_ELECTRICITY_ID',
  CABLEBILLS: 'META_WHATSAPP_FLOW_TV_ID',
  INTSERVICE: 'META_WHATSAPP_FLOW_INTERNET_ID',
};

async function main(): Promise<void> {
  const wabaId = String(process.env.META_WHATSAPP_WABA_ID || '').trim();
  if (!wabaId) throw new Error('META_WHATSAPP_WABA_ID is required');

  const existing = await listFlows(wabaId);
  const categories = Object.keys(AZAP_BILL_FLOW_NAMES) as BillCategoryCode[];
  const lines: string[] = [];

  for (const category of categories) {
    const name = AZAP_BILL_FLOW_NAMES[category];
    const json = AZAP_BILL_FLOW_JSON_BY_CATEGORY[category];
    console.log(`\n→ ${category} (${name})`);
    const match = existing.find((f) => f.name === name);
    let flowId = match?.id;
    if (flowId) {
      console.log(`  reuse id=${flowId} status=${match?.status}`);
    } else {
      flowId = await createFlow(wabaId, name);
      console.log(`  created id=${flowId}`);
    }
    await uploadFlowJson(flowId, json);
    try {
      await graphPost(`${flowId}/publish`);
      console.log('  published');
    } catch (err) {
      console.warn(
        '  publish:',
        err instanceof Error ? err.message : err
      );
    }
    lines.push(`${ENV_KEYS[category]}=${flowId}`);
  }

  console.log('\nAdd to VPS / .env:\n');
  for (const line of lines) console.log(line);
  console.log('META_WHATSAPP_BILL_FLOW_MODE=draft');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
