import pgPromise from 'pg-promise';

const pgp = pgPromise();

const connectionString =
  process.env.DAYFI_DATABASE_URL ?? process.env.DATABASE_URL;

function useSsl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    const sslmode = u.searchParams.get('sslmode');
    if (sslmode === 'disable' || sslmode === 'no-verify') return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'postgres') {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

const db = pgp({
  connectionString,
  ...(useSsl(connectionString)
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

export { db };
