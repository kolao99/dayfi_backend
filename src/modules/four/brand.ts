/**
 * User-facing Azap branding.
 *
 * Internal module paths may still say `four_*` / `/api/v1/four` — those are
 * API/DB identifiers. Conversational product name is Azap / Azap by Dayfi.
 *
 * Env (preferred → legacy fallback):
 *   AZAP_ASSISTANT_NAME || FOUR_ASSISTANT_NAME || "Azap"
 *   AZAP_FULL_BRAND_NAME || "Azap by Dayfi"
 */

export function assistantName(): string {
  const name = String(
    process.env.AZAP_ASSISTANT_NAME ||
      process.env.FOUR_ASSISTANT_NAME ||
      'Azap'
  ).trim();
  // Migrate legacy default if someone still has MONY in env.
  if (!name || /^mony$/i.test(name)) return 'Azap';
  return name;
}

/** Formal brand for onboarding / marketing contexts. */
export function fullBrandName(): string {
  const name = String(
    process.env.AZAP_FULL_BRAND_NAME || 'Azap by Dayfi'
  ).trim();
  return name || 'Azap by Dayfi';
}

/** Suggested WhatsApp contact display (Meta Business display name is set in Meta). */
export function contactDisplayName(): string {
  return fullBrandName();
}
