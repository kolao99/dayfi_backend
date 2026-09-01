-- Reverse of Four Phase 1 (C4 + C5).

DROP INDEX IF EXISTS idx_four_otp_phone_created;
DROP TABLE IF EXISTS four_otp_challenges;

DROP INDEX IF EXISTS idx_four_sessions_expires;
DROP INDEX IF EXISTS idx_four_sessions_user_active;
DROP TABLE IF EXISTS four_sessions;
