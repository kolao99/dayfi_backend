/* Replace with your SQL commands */
DROP INDEX IF EXISTS idx_blacklisted_tokens_token;
DROP INDEX IF EXISTS idx_users_phone_number;
DROP INDEX IF EXISTS idx_users_verification_email;
DROP INDEX IF EXISTS idx_users_email;

DROP TABLE IF EXISTS blacklisted_jwt_tokens;
DROP TABLE IF EXISTS users;

DROP EXTENSION IF EXISTS pgcrypto;
