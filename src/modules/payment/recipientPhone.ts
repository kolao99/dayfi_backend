/** Normalize recipient/sender phone for Yellow Card and Joi validation. */
export function normalizeRecipientPhone(
  phone: string | undefined | null,
  country: string,
  fallback?: string | null
): string {
  const trimmed = String(phone ?? '').trim();
  if (trimmed.length > 0) return trimmed;

  const fb = String(fallback ?? '').trim();
  if (fb.length > 0) return fb;

  return String(country).toUpperCase() === 'NG'
    ? '+2340000000000'
    : '+10000000000';
}
