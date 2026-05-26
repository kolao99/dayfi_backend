/**
 * Async crypto wallet provisioning (Stellar + EVM) for stablecoin receive.
 * Mirrors dayfi.wallet patterns: BIP39 mnemonic, testnet friendbot / optional master funding, USDC trustline.
 */
import crypto from 'node:crypto';
import { db } from '../../config/database';
import StellarSdk from '@stellar/stellar-sdk';
import { ethers } from 'ethers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const StellarHDWallet = require('stellar-hd-wallet') as {
  generateMnemonic: (opts: { entropyBits: number }) => string;
  fromMnemonic: (m: string) => {
    getKeypair: (index: number) => {
      publicKey: () => string;
      secret: () => string;
    };
  };
};

const ALGORITHM = 'aes-256-gcm';

type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

type JobRecord = {
  userId: string;
  status: JobStatus;
  current_step: string;
  error: string | null;
  /** Plain mnemonic until delivered once in GET status, then cleared. */
  mnemonicPending: string | null;
  recoveryDelivered: boolean;
};

const jobs = new Map<string, JobRecord>();

const isTestnet = () =>
  (process.env.STELLAR_NETWORK || 'testnet').toLowerCase() !== 'mainnet';

const horizonUrl = () =>
  process.env.STELLAR_HORIZON_URL ||
  (isTestnet()
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org');

const networkPassphrase = () =>
  isTestnet() ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;

const usdcIssuer = () =>
  process.env.STELLAR_USDC_ISSUER ||
  process.env.USDC_ISSUER ||
  (isTestnet()
    ? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    : 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

function getEncryptionKey(): Buffer {
  const keyHex = (process.env.WALLET_ENCRYPTION_KEY || '').trim();
  if (!keyHex || keyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes) for crypto wallet storage'
    );
  }
  return Buffer.from(keyHex, 'hex');
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

function decryptMasterSecret(secretValue: string): string {
  const value = String(secretValue || '').trim();
  const parts = value.split(':');
  const looksEncrypted =
    parts.length === 3 &&
    /^[0-9a-f]+$/i.test(parts[0]) &&
    /^[0-9a-f]+$/i.test(parts[1]) &&
    /^[0-9a-f]+$/i.test(parts[2]) &&
    parts[0].length === 32 &&
    parts[1].length === 32;
  if (looksEncrypted) return decryptSecret(value);
  return value;
}

async function loadWalletRow(userId: string): Promise<{
  wallet_id: string;
  stellar_deposit_address: string | null;
  ethereum_deposit_address: string | null;
} | null> {
  return db.oneOrNone(
    `SELECT wallet_id, stellar_deposit_address, ethereum_deposit_address
     FROM wallets
     WHERE user_id = $1 AND currency = 'USD'
     ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
}

/** Stellar / EVM deposit addresses live on the unified USD wallet row. */
async function ensureUsdWalletRow(userId: string): Promise<void> {
  const row = await loadWalletRow(userId);
  if (row) return;
  const reference = `wallet-ref-usd-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
  await db.none(
    `INSERT INTO wallets (user_id, balance, wallet_reference, currency, provider, created_at, updated_at)
     VALUES ($1, 0.00, $2, 'USD', 'platform', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [userId, reference]
  );
}

async function persistCryptoWallet(params: {
  userId: string;
  stellarPublic: string;
  stellarSecretEnc: string;
  ethAddress: string;
  ethSecretEnc: string;
  mnemonicEnc: string;
}): Promise<void> {
  await db.none(
    `UPDATE wallets SET
       stellar_deposit_address = $1,
       stellar_secret_encrypted = $2,
       ethereum_deposit_address = $3,
       ethereum_secret_encrypted = $4,
       crypto_mnemonic_encrypted = $5,
       updated_at = CURRENT_TIMESTAMP
     WHERE wallet_id = (
       SELECT wallet_id FROM wallets WHERE user_id = $6 AND currency = 'USD' LIMIT 1
     )`,
    [
      params.stellarPublic,
      params.stellarSecretEnc,
      params.ethAddress,
      params.ethSecretEnc,
      params.mnemonicEnc,
      params.userId,
    ]
  );
}

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
  );
  const bodyText = await res.text();
  if (!res.ok) {
    const server = new StellarSdk.Horizon.Server(horizonUrl());
    try {
      await server.loadAccount(publicKey);
      await new Promise((r) => setTimeout(r, 2000));
      return;
    } catch {
      throw new Error(`Friendbot failed (${res.status}): ${bodyText}`);
    }
  }
  await new Promise((r) => setTimeout(r, 2500));
}

async function fundFromMasterIfConfigured(userPublicKey: string): Promise<boolean> {
  const masterPublicKey = process.env.MASTER_WALLET_PUBLIC_KEY?.trim();
  const masterSecretEnc = process.env.MASTER_WALLET_SECRET_KEY?.trim();
  const fundingAmount = process.env.STELLAR_FUNDING_AMOUNT_XLM || '5';
  if (!masterPublicKey || !masterSecretEnc) return false;

  const server = new StellarSdk.Horizon.Server(horizonUrl());
  const masterSecret = decryptMasterSecret(masterSecretEnc);
  const masterKeypair = StellarSdk.Keypair.fromSecret(masterSecret);
  const masterAccount = await server.loadAccount(masterPublicKey);

  let destExists = true;
  try {
    await server.loadAccount(userPublicKey);
  } catch (err: any) {
    if (err?.response?.status === 404) destExists = false;
    else throw err;
  }

  const txBuilder = new StellarSdk.TransactionBuilder(masterAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: networkPassphrase(),
  });

  if (!destExists) {
    txBuilder.addOperation(
      StellarSdk.Operation.createAccount({
        destination: userPublicKey,
        startingBalance: fundingAmount,
      })
    );
  } else {
    txBuilder.addOperation(
      StellarSdk.Operation.payment({
        destination: userPublicKey,
        asset: StellarSdk.Asset.native(),
        amount: fundingAmount,
      })
    );
  }

  const tx = txBuilder.setTimeout(60).build();
  tx.sign(masterKeypair);
  await server.submitTransaction(tx);
  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

async function addUsdcTrustline(stellarSecret: string): Promise<void> {
  const server = new StellarSdk.Horizon.Server(horizonUrl());
  const keypair = StellarSdk.Keypair.fromSecret(stellarSecret);
  const publicKey = keypair.publicKey();
  const usdc = new StellarSdk.Asset('USDC', usdcIssuer());
  const account = await server.loadAccount(publicKey);
  const nativeBalance = parseFloat(
    String(
      (account.balances as { asset_type?: string; balance?: string }[]).find(
        (b) => b.asset_type === 'native'
      )?.balance || '0'
    )
  );
  if (nativeBalance < 0.5) {
    throw new Error(
      `Insufficient XLM (${nativeBalance}) on ${publicKey} to pay trustline fees`
    );
  }
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset: usdc,
        limit: '10000000',
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await server.submitTransaction(tx);
}

function setJob(jobId: string, patch: Partial<JobRecord>) {
  const cur = jobs.get(jobId);
  if (!cur) return;
  jobs.set(jobId, { ...cur, ...patch });
}

async function runJob(jobId: string, userId: string): Promise<void> {
  setJob(jobId, { status: 'processing', current_step: 'stellar_wallet', error: null });

  try {
    const mnemonic = StellarHDWallet.generateMnemonic({ entropyBits: 128 });
    const hd = StellarHDWallet.fromMnemonic(mnemonic);
    const stellarKp = hd.getKeypair(0);
    const stellarPublic = stellarKp.publicKey();
    const stellarSecret = stellarKp.secret();

    setJob(jobId, { current_step: 'ethereum_wallet' });
    const ethWallet = ethers.Wallet.createRandom();
    const ethAddress = ethWallet.address;
    const ethSecret = ethWallet.privateKey;

    setJob(jobId, { current_step: 'fund_stellar' });

    if (isTestnet()) {
      const fundedByMaster = await fundFromMasterIfConfigured(stellarPublic);
      if (!fundedByMaster) {
        await fundWithFriendbot(stellarPublic);
      }
    } else {
      const ok = await fundFromMasterIfConfigured(stellarPublic);
      if (!ok) {
        throw new Error(
          'Mainnet requires MASTER_WALLET_PUBLIC_KEY and MASTER_WALLET_SECRET_KEY to fund new Stellar accounts'
        );
      }
    }

    setJob(jobId, { current_step: 'trustlines' });
    await addUsdcTrustline(stellarSecret);

    setJob(jobId, { current_step: 'finalize' });
    await persistCryptoWallet({
      userId,
      stellarPublic,
      stellarSecretEnc: encryptSecret(stellarSecret),
      ethAddress,
      ethSecretEnc: encryptSecret(ethSecret),
      mnemonicEnc: encryptSecret(mnemonic),
    });

    setJob(jobId, {
      status: 'completed',
      current_step: 'finalize',
      mnemonicPending: mnemonic,
      recoveryDelivered: false,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    setJob(jobId, {
      status: 'failed',
      error: msg,
      mnemonicPending: null,
    });
  }
}

export async function enqueueCryptoWalletProvision(
  userId: string
): Promise<{ job_id: string; status?: string }> {
  const uid = String(userId || '').trim();
  if (!uid) {
    throw new Error('Invalid user session');
  }
  await ensureUsdWalletRow(uid);
  const row = await loadWalletRow(uid);
  if (!row) {
    throw new Error('No wallet record found for user');
  }
  if (row.stellar_deposit_address && row.ethereum_deposit_address) {
    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      userId: uid,
      status: 'completed',
      current_step: 'finalize',
      error: null,
      mnemonicPending: null,
      recoveryDelivered: true,
    });
    return { job_id: jobId, status: 'completed' };
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    userId: uid,
    status: 'processing',
    current_step: 'stellar_wallet',
    error: null,
    mnemonicPending: null,
    recoveryDelivered: false,
  });
  void runJob(jobId, uid);
  return { job_id: jobId };
}

export function getCryptoWalletProvisionJob(
  jobId: string,
  userId: string
): Record<string, unknown> | null {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;

  const base: Record<string, unknown> = {
    status: job.status,
    current_step: job.current_step,
  };
  if (job.error) base.error = job.error;

  if (
    job.status === 'completed' &&
    job.mnemonicPending &&
    !job.recoveryDelivered
  ) {
    base.recovery_phrase = job.mnemonicPending;
    base.is_wallet_backed_up = false;
    job.recoveryDelivered = true;
    job.mnemonicPending = null;
    jobs.set(jobId, job);
  }

  return base;
}
