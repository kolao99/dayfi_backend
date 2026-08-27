import pgPromise from 'pg-promise';

const pgp = pgPromise();

const connectionString =
  process.env.DAYFI_DATABASE_URL ?? process.env.DATABASE_URL;

function useSsl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return !(host === 'localhost' || host === '127.0.0.1');
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
