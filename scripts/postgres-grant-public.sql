-- If `npm run migrate:up` fails with: permission denied for schema public
-- connect with a SUPERUSER role (often `postgres`) to the SAME database as DAYFI_DATABASE_URL,
-- replace `app_user` with the username from your connection string, then run the GRANTs you need.

-- Example: connection is postgresql://app_user:secret@host:5432/mydb
-- GRANT USAGE ON SCHEMA public TO app_user;
-- GRANT CREATE ON SCHEMA public TO app_user;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_user;

-- On some hosts (e.g. older defaults), making the user own the schema fixes migrations:
-- ALTER SCHEMA public OWNER TO app_user;
