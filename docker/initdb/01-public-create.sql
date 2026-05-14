-- PostgreSQL 15+ revokes CREATE on schema public for role PUBLIC.
-- This file runs once on a fresh volume (docker-entrypoint-initdb.d) as POSTGRES_USER on POSTGRES_DB.
ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
