import pgPromise from 'pg-promise';

const pgp = pgPromise();

const db = pgp({
  connectionString:
    process.env.DAYFI_DATABASE_URL ?? process.env.DATABASE_URL,
  // ssl: {
  // require: true,
  // rejectUnauthorized: false, // needed for Heroku
  // },
});

export { db };
