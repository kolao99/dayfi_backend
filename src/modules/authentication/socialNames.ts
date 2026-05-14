const MAX_LEN = 100;

export function trimName(value: unknown): string {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s) return '';
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
}

/** Google userinfo: given_name, family_name, name (full). */
export function namesFromGoogleUserinfo(data: Record<string, unknown>): {
  firstName: string;
  lastName: string;
} {
  const given = trimName(data.given_name);
  const family = trimName(data.family_name);
  if (given && family) return { firstName: given, lastName: family };
  if (given) return { firstName: given, lastName: '' };
  if (family) return { firstName: family, lastName: '' };
  const full = trimName(data.name);
  if (full) {
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }
  return { firstName: '', lastName: '' };
}

export function fallbackFirstNameFromEmail(email: string): string {
  const local = email.split('@')[0]?.trim() || 'user';
  const cleaned = local.replace(/[._+-]+/g, ' ').trim();
  if (!cleaned) return 'User';
  const titled = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return trimName(titled) || 'User';
}

/** Apple sends names only on first authorization; client may omit both. */
export function namesFromAppleClient(
  firstName: string | undefined,
  lastName: string | undefined,
  emailForFallback: string
): { firstName: string; lastName: string } {
  const f = trimName(firstName);
  const l = trimName(lastName);
  if (f || l) {
    return {
      firstName: f || l,
      lastName: f ? l : '',
    };
  }
  return {
    firstName: fallbackFirstNameFromEmail(emailForFallback),
    lastName: '',
  };
}
