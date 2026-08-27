import { configDotenv } from 'dotenv';
import process from 'node:process';
configDotenv();
configDotenv({ path: '.env.local', override: true });

const resolvedDatabaseUrl = () => {
  const raw =
    process.env.DAYFI_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  return raw || undefined;
};

const development = {
  NODE_ENV: process.env.DAYFI_NODE_ENV ?? process.env.NODE_ENV ?? 'development',
  PORT: process.env.DAYFI_PORT ?? process.env.PORT,
  DATABASE_URL: resolvedDatabaseUrl(),
  JWT_SECRET: process.env.DAYFI_JWT_SECRET,
  JWT_TIME_TO_LIVE: process.env.DAYFI_JWT_TIME_TO_LIVE,
  SALT_ROUND: process.env.DAYFI_SALT_ROUND,
  PAYSTACK_URL: process.env.DAYFI_PAYSTACK_URL,
  PAYSTACK_SECRET_KEY: process.env.DAYFI_PAYSTACK_SECRET_KEY,
  PAYSTACK_PUBLIC_KEY: process.env.DAYFI_PAYSTACK_PUBLIC_KEY,
  MONO_SECRET_KEY: process.env.DAYFI_MONO_SECRET_KEY,
  MONO_PUBLIC_KEY: process.env.DAYFI_MONO_PUBLIC_KEY,
  FLUTTERWAVE_SECRET_KEY: process.env.DAYFI_FLUTTERWAVE_SECRET_KEY,
  FLUTTERWAVE_PUBLIC_KEY: process.env.DAYFI_FLUTTERWAVE_PUBLIC_KEY,
  FLUTTERWAVE_ENCRYPTION_KEY: process.env.DAYFI_FLUTTERWAVE_ENCRYPTION_KEY,
  FLUTTERWAVE_BASE_URL: process.env.DAYFI_FLUTTERWAVE_BASE_URL,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID,
  YELLOWCARD_API_KEY: process.env.DAYFI_YELLOWCARD_API_KEY,
  YELLOWCARD_API_SECRET: process.env.DAYFI_YELLOWCARD_API_SECRET,
  YELLOWCARD_BASE_URL: process.env.DAYFI_YELLOWCARD_BASE_URL,
  GREY_API_KEY: process.env.DAYFI_GREY_API_KEY,
  GREY_BASE_URL: process.env.DAYFI_GREY_BASE_URL,
  GREY_WEBHOOK_SECRET: process.env.DAYFI_GREY_WEBHOOK_SECRET,
  GREY_SANDBOX: process.env.DAYFI_GREY_SANDBOX !== 'false',
  /** When true and Yellow Card env is complete, clients may enable stablecoin top-up / send. */
  STABLECOIN_TOPUP_ENABLED:
    process.env.DAYFI_STABLECOIN_TOPUP_ENABLED === 'true',
  SMILE_PARTNER_ID: process.env.DAYFI_SMILE_PARTNER_ID,
  SMILE_API_KEY: process.env.DAYFI_SMILE_API_KEY,
  SMILE_BASE_URL: process.env.DAYFI_SMILE_BASE_URL,
  SMILE_CALLBACK_URL: process.env.DAYFI_SMILE_CALLBACK_URL,
};

export default development;
