/**
 * Create + upload + publish the Azap PIN setup WhatsApp Flow.
 *
 * Usage:
 *   npx ts-node -r dotenv/config scripts/publish-azap-pin-flow.ts
 *
 * Requires:
 *   META_WHATSAPP_ACCESS_TOKEN
 *   META_WHATSAPP_WABA_ID
 *
 * Prints META_WHATSAPP_PIN_FLOW_ID / _NAME to add to .env / VPS.
 */
import axios from 'axios';
import FormData from 'form-data';
import {
  AZAP_PIN_SETUP_FLOW_JSON,
  AZAP_PIN_SETUP_FLOW_NAME,
} from '../src/modules/four/whatsapp/flows/pinSetupFlowJson';

const GRAPH_VERSION =
  String(process.env.META_WHATSAPP_GRAPH_VERSION || 'v21.0').trim() ||
  'v21.0';

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

async function listFlows(wabaId: string): Promise<
  Array<{ id: string; name: string; status?: string }>
> {
  const data = await graphGet<{
    data?: Array<{ id: string; name: string; status?: string }>;
  }>(`${wabaId}/flows?fields=id,name,status&limit=100`);
  return data.data ?? [];
}

async function createFlow(wabaId: string, name: string): Promise<string> {
  const data = await graphPost<{ id: string }>(`${wabaId}/flows`, {
    name,
    categories: ['SIGN_UP'],
  });
  if (!data.id) throw new Error('Flow create returned no id');
  return data.id;
}

async function uploadFlowJson(flowId: string): Promise<void> {
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append(
    'file',
    Buffer.from(JSON.stringify(AZAP_PIN_SETUP_FLOW_JSON), 'utf8'),
    {
      filename: 'flow.json',
      contentType: 'application/json',
    }
  );

  const res = await axios.post(
    `${graphBase()}/${flowId}/assets`,
    form,
    {
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      validateStatus: () => true,
    }
  );

  if (res.status >= 400) {
    console.error(JSON.stringify(res.data, null, 2));
    const err = res.data?.error;
    throw new Error(
      err?.error_user_msg || err?.message || `Asset upload → ${res.status}`
    );
  }

  if (res.data?.validation_errors?.length) {
    console.error('Flow JSON validation errors:', res.data.validation_errors);
    throw new Error('Flow JSON failed Meta validation');
  }

  console.log('Uploaded flow.json asset OK');
}

async function publishFlow(flowId: string): Promise<void> {
  await graphPost(`${flowId}/publish`);
  console.log('Published flow OK');
}

async function main(): Promise<void> {
  const wabaId = String(process.env.META_WHATSAPP_WABA_ID || '').trim();
  if (!wabaId) throw new Error('META_WHATSAPP_WABA_ID is required');

  const existing = await listFlows(wabaId);
  const match = existing.find((f) => f.name === AZAP_PIN_SETUP_FLOW_NAME);

  let flowId = match?.id;
  if (flowId) {
    console.log(
      `Reusing existing flow ${AZAP_PIN_SETUP_FLOW_NAME} id=${flowId} status=${match?.status ?? '?'}`
    );
  } else {
    flowId = await createFlow(wabaId, AZAP_PIN_SETUP_FLOW_NAME);
    console.log(`Created flow ${AZAP_PIN_SETUP_FLOW_NAME} id=${flowId}`);
  }

  await uploadFlowJson(flowId);

  try {
    await publishFlow(flowId);
  } catch (err) {
    console.warn(
      'Publish note:',
      err instanceof Error ? err.message : err
    );
  }

  console.log('\nAdd to VPS / .env:\n');
  console.log(`META_WHATSAPP_PIN_FLOW_ID=${flowId}`);
  console.log(`META_WHATSAPP_PIN_FLOW_NAME=${AZAP_PIN_SETUP_FLOW_NAME}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
