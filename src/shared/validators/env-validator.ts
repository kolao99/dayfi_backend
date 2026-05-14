import Joi from 'joi';
import { AppEnv } from '../enums';

export interface EnvProps {
  PORT: number;
  NODE_ENV: string;
  DATABASE_URL: string;
}

export const envValidatorSchema = Joi.object<EnvProps>({
  PORT: Joi.number().port().default(3000),
  NODE_ENV: Joi.string()
    .required()
    .valid(AppEnv.DEVELOPMENT, AppEnv.PRODUCTION)
    .default(AppEnv.DEVELOPMENT),

  DATABASE_URL: Joi.string()
    .trim()
    .min(1)
    .required()
    .custom((value, helpers) => {
      try {
        const u = new URL(value);
        const username = decodeURIComponent(u.username);
        if (!username) {
          return helpers.error('any.invalid');
        }
        if (username === 'USER') {
          return helpers.error('any.invalid');
        }
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    })
    .messages({
      'string.min':
        'Set DAYFI_DATABASE_URL or DATABASE_URL in .env (e.g. postgresql://user:pass@127.0.0.1:5433/dayfi for Docker Compose)',
      'any.required':
        'Set DAYFI_DATABASE_URL or DATABASE_URL in .env (e.g. postgresql://user:pass@127.0.0.1:5433/dayfi for Docker Compose)',
      'any.invalid':
        'DAYFI_DATABASE_URL must be a valid postgresql:// URL with a real DB role as the username (e.g. postgres), not the placeholder USER.',
    }),
}).unknown(true);
