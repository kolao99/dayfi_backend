import Twilio from 'twilio';

export type TwilioWhatsappInbound = {
  messageSid: string;
  fromPhoneE164: string;
  toPhoneE164: string;
  body: string;
  buttonPayload?: string;
  profileName?: string;
};

/** Strip `whatsapp:` prefix and normalize to E.164-ish string from Twilio. */
export function parseTwilioWhatsappAddress(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^whatsapp:/i, '');
}

export function parseTwilioInbound(body: Record<string, unknown>): TwilioWhatsappInbound | null {
  const from = parseTwilioWhatsappAddress(String(body.From ?? ''));
  const to = parseTwilioWhatsappAddress(String(body.To ?? ''));
  const messageSid = String(body.MessageSid ?? body.SmsMessageSid ?? '').trim();
  const text = String(body.Body ?? body.ButtonText ?? '').trim();
  const buttonPayload = String(body.ButtonPayload ?? '').trim();

  if (!from || !messageSid) return null;

  return {
    messageSid,
    fromPhoneE164: from.startsWith('+') ? from : `+${from}`,
    toPhoneE164: to.startsWith('+') ? to : to ? `+${to}` : '',
    body: text,
    buttonPayload: buttonPayload || undefined,
    profileName: String(body.ProfileName ?? '').trim() || undefined,
  };
}

export function validateTwilioWebhookSignature(input: {
  authToken: string;
  signature: string;
  url: string;
  params: Record<string, string>;
}): boolean {
  return Twilio.validateRequest(
    input.authToken,
    input.signature,
    input.url,
    input.params
  );
}

export async function sendTwilioWhatsappMessage(input: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string | null }> {
  const client = Twilio(input.accountSid, input.authToken);
  const from = input.from.startsWith('whatsapp:')
    ? input.from
    : `whatsapp:${input.from}`;
  const to = input.to.startsWith('whatsapp:')
    ? input.to
    : `whatsapp:${input.to}`;

  const message = await client.messages.create({
    from,
    to,
    body: input.body,
  });

  return { sid: message.sid ?? null };
}
