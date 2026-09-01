-- Reverse of Four Phase 1 (C3).
--
-- Restoring NOT NULL on email/password is only safe when no phone-only user
-- exists. If Four has already created passwordless users, those rows must be
-- resolved by hand before the constraint can come back, so the DO blocks below
-- raise a clear error instead of failing on an opaque constraint violation.

DROP INDEX IF EXISTS users_phone_e164_key;

ALTER TABLE users
  DROP COLUMN IF EXISTS phone_e164,
  DROP COLUMN IF EXISTS phone_verified,
  DROP COLUMN IF EXISTS phone_verified_at,
  DROP COLUMN IF EXISTS last_seen_at;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email IS NULL) THEN
    RAISE EXCEPTION
      'Cannot restore users.email NOT NULL: % row(s) have a NULL email (phone-only Four users). Resolve them first.',
      (SELECT count(*) FROM users WHERE email IS NULL);
  END IF;
  ALTER TABLE users ALTER COLUMN email SET NOT NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE password IS NULL) THEN
    RAISE EXCEPTION
      'Cannot restore users.password NOT NULL: % row(s) have a NULL password (passwordless Four users). Resolve them first.',
      (SELECT count(*) FROM users WHERE password IS NULL);
  END IF;
  ALTER TABLE users ALTER COLUMN password SET NOT NULL;
END $$;
