/**
 * Increment B — Stellar custody for infra org wallets.
 *
 * Secrets live only in infra_stellar_custody (encrypted).
 * Never log secrets. Never return secrets from public APIs.
 */

import crypto from 'node:crypto';
import StellarSdk from '@stellar/stellar-sdk';
import { db } from '../../config/database';

const ALGORITHM = 'aes-256-gcm';
const DEV_ENCRYPTION_KEY_HEX = 'b'.repeat(64);

export class StellarCustodyError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'StellarCustodyError';
    this.code = code;
    this.status = status;
  }
}

export type StellarCustodyProvider = {
  createKeypairAndStore(): Promise<{
    custodyRef: string;
    publicKey: string;
  }>;
  getPublicKey(custodyRef: string): Promise<string>;
  /** Internal signing only — never expose via HTTP. */
  getSigningSecret(custodyRef: string): Promise<string>;
};

function getEncryptionKey(): Buffer {
  const keyHex = (
    process.env.DAYFI_INFRA_STELLAR_CUSTODY_KEY ||
    process.env.WALLET_ENCRYPTION_KEY ||
    ''
  ).trim();
  const nodeEnv = (process.env.DAYFI_NODE_ENV || process.env.NODE_ENV || '')
    .toLowerCase();
  const effective =
    keyHex && keyHex.length === 64 && /^[0-9a-fA-F]+$/.test(keyHex)
      ? keyHex
      : nodeEnv === 'production'
        ? ''
        : DEV_ENCRYPTION_KEY_HEX;
  if (!effective) {
    throw new StellarCustodyError(
      'DAYFI_INFRA_STELLAR_CUSTODY_KEY (or WALLET_ENCRYPTION_KEY) must be 64 hex chars',
      'MISSING_CUSTODY_KEY',
      500
    );
  }
  return Buffer.from(effective, 'hex');
}

function encryptSecret(plain: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(plain, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

function decryptSecret(encText: string): string {
  const key = getEncryptionKey();
  const [ivHex, tagHex, enc] = String(encText || '').split(':');
  if (!ivHex || !tagHex || !enc) {
    throw new StellarCustodyError('Invalid custody ciphertext', 'INVALID_CIPHER', 500);
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

/** Default AES-GCM vault backed by infra_stellar_custody. */
export const encryptedStellarCustody: StellarCustodyProvider = {
  async createKeypairAndStore() {
    const kp = StellarSdk.Keypair.random();
    const publicKey = kp.publicKey();
    const secretEncrypted = encryptSecret(kp.secret());
    const row = await db.one<{ id: string }>(
      `INSERT INTO infra_stellar_custody (secret_encrypted)
       VALUES ($1)
       RETURNING id::text AS id`,
      [secretEncrypted]
    );
    return { custodyRef: row.id, publicKey };
  },

  async getPublicKey(custodyRef: string) {
    const secret = await this.getSigningSecret(custodyRef);
    return StellarSdk.Keypair.fromSecret(secret).publicKey();
  },

  async getSigningSecret(custodyRef: string) {
    const row = await db.oneOrNone<{ secret_encrypted: string }>(
      `SELECT secret_encrypted FROM infra_stellar_custody WHERE id = $1`,
      [custodyRef]
    );
    if (!row) {
      throw new StellarCustodyError('Custody record not found', 'CUSTODY_NOT_FOUND', 404);
    }
    return decryptSecret(row.secret_encrypted);
  },
};

export function getStellarCustodyProvider(): StellarCustodyProvider {
  return encryptedStellarCustody;
}
