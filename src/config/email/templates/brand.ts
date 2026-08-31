/** Dayfi marketing site palette — matches azza-landing.css */
export const DAYFI_EMAIL_BRAND = {
  brand: '#3430e9',
  brandSoft: '#0b1728',
  canvas: '#fef9f3',
  ink: '#1a1a1a',
  muted: '#64748b',
  lime: '#d3feb6',
  white: '#ffffff',
  border: '#e8ecf2',
  error: '#e5484d',
} as const;

export function dayfiEmailLogoUrl(): string {
  return (
    process.env.DAYFI_EMAIL_LOGO_URL?.trim() ||
    'https://www.dayfi.co/assets/dayfi_logo.png'
  );
}

export function dayfiPublicUrl(): string {
  return process.env.DAYFI_PUBLIC_URL?.trim() || 'https://www.dayfi.co';
}
