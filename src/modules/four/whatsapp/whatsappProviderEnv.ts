/** Which WhatsApp transport backs Azap outbound + webhooks. */
export type WhatsappProvider = 'meta' | 'twilio' | 'stub';

export function resolveWhatsappProvider(): WhatsappProvider {
  const mode = String(process.env.FOUR_WHATSAPP_MODE || '').trim().toLowerCase();
  if (mode === 'stub') return 'stub';

  const configured = String(process.env.FOUR_WHATSAPP_PROVIDER || '')
    .trim()
    .toLowerCase();

  if (configured === 'meta') {
    const token = String(process.env.META_WHATSAPP_ACCESS_TOKEN || '').trim();
    const phoneNumberId = String(
      process.env.META_WHATSAPP_PHONE_NUMBER_ID || ''
    ).trim();
    if (token && phoneNumberId) return 'meta';
  }

  if (String(process.env.TWILIO_WHATSAPP_FROM || '').trim()) return 'twilio';

  return 'stub';
}

export function isMetaWhatsappProvider(): boolean {
  return resolveWhatsappProvider() === 'meta';
}

export function isTwilioWhatsappProvider(): boolean {
  return resolveWhatsappProvider() === 'twilio';
}
