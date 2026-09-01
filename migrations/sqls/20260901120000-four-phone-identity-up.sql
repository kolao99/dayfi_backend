-- Four Phase 1 (C3): phone number becomes a login key on the existing user identity.
--
-- Rule D1: one consumer = one `users` row; multiple auth methods point at it.
-- Phone OTP is an ADDITIONAL verified login method, never a parallel account.
--
-- `email` and `password` become nullable so a passwordless phone-only user can
-- exist. Existing email/password, Google and Apple sign-in paths are untouched:
-- this migration only relaxes a constraint, it removes no column and no route.
--
-- NOTE: this migration deliberately does NOT backfill `phone_e164` from
-- `phone_number`. Backfill can collide (e.g. '08012345678' and '+2348012345678'
-- normalize to the same value) and must be run through the dry-run reporter
-- first: `npm run four:phone-backfill` (report) then `-- --apply`.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR(20),
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Partial unique index: many users may have NULL phone_e164 (email-only
-- accounts), but a verified E.164 number resolves to exactly one identity.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_e164_key
  ON users (phone_e164)
  WHERE phone_e164 IS NOT NULL;
