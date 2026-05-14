import axios from 'axios';

const RESEND_API = 'https://api.resend.com/emails';

export type ResendSendPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export async function sendViaResend(
  apiKey: string,
  payload: ResendSendPayload
): Promise<{ id: string }> {
  try {
    const res = await axios.post<Record<string, unknown>>(
      RESEND_API,
      {
        from: payload.from,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 25_000,
        validateStatus: () => true,
      }
    );

    const data = res.data ?? {};
    const id = typeof data.id === 'string' ? data.id : '';
    if (res.status >= 200 && res.status < 300 && id.length > 0) {
      return { id };
    }

    const msg =
      typeof data.message === 'string' && data.message.length > 0
        ? data.message
        : `Resend send failed (HTTP ${res.status})`;
    throw new Error(msg);
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const body = e.response?.data as { message?: string } | undefined;
      const msg =
        body?.message ||
        e.message ||
        'Resend request failed';
      throw new Error(String(msg));
    }
    throw e;
  }
}
