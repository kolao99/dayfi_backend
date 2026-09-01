-- Four Phase 1 (C4 + C5): server-side sessions and OTP challenge policy.
--
-- C4 — four_sessions: the consumer app currently issues a stateless 30-day JWT
-- with revocation only via a blacklist. Four needs real sessions it can expire
-- and revoke, and a session identity to hang conversation restore off.
--
-- C5 — four_otp_challenges: Twilio Verify holds the code; Four holds the
-- policy (send rate limit, attempt cap, expiry, single use). Without this an
-- attacker can pump SMS cost and brute-force a 6-digit code.

CREATE TABLE IF NOT EXISTS four_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- SHA-256 of the opaque bearer token. The raw token is returned to the
  -- client exactly once and never stored.
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  device_label VARCHAR(120),
  platform VARCHAR(32),
  ip VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_four_sessions_user_active
  ON four_sessions (user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_four_sessions_expires
  ON four_sessions (expires_at);

CREATE TABLE IF NOT EXISTS four_otp_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Challenges are keyed by phone, NOT by user: at request-otp time Four has
  -- deliberately not resolved whether the number belongs to anyone (D1.4,
  -- no account enumeration).
  phone_e164 VARCHAR(20) NOT NULL,
  purpose VARCHAR(32) NOT NULL DEFAULT 'login'
    CHECK (purpose IN ('login', 'add_phone', 'recover')),
  provider VARCHAR(32) NOT NULL DEFAULT 'twilio',
  provider_ref VARCHAR(64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Drives both "is there a live challenge for this number" and the send-rate
-- window count.
CREATE INDEX IF NOT EXISTS idx_four_otp_phone_created
  ON four_otp_challenges (phone_e164, created_at DESC);
