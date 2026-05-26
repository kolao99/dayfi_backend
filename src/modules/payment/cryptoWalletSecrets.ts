import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const DEV_ENCRYPTION_KEY_HEX = 'a'.repeat(64);

function getEncryptionKey(): Buffer {
  const keyHex = (process.env.WALLET_ENCRYPTION_KEY || '').trim();
  const nodeEnv = (process.env.DAYFI_NODE_ENV || process.env.NODE_ENV || '')
    .toLowerCase();
  const effective =
    keyHex && keyHex.length === 64 && /^[0-9a-fA-F]+$/.test(keyHex)
      ? keyHex
      : nodeEnv === 'production'
        ? ''
        : DEV_ENCRYPTION_KEY_HEX;
  if (!effective) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes) for crypto wallet storage'
    );
  }
  return Buffer.from(effective, 'hex');
}

export function decryptWalletSecret(encText: string): string {
  const key = getEncryptionKey();
  const [ivHex, tagHex, enc] = encText.split(':');
  if (!ivHex || !tagHex || !enc) return encText;
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
