-- Four Telegram-native onboarding metadata on links.

ALTER TABLE four_telegram_links
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
