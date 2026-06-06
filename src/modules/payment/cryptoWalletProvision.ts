/**
 * Crypto wallet provisioning (Stellar + EVM) for USDC/EURC receive on testnet/mainnet.
 * @see dayfi.wallet walletService.js
 */
import crypto from 'node:crypto';
import { db } from '../../config/database';
import StellarSdk from '@stellar/stellar-sdk';
import { ethers } from 'ethers';
import {
  buildReceiveTrustlineAssets,
  resolveEthTokenContracts,
} from '../../config/stellarIssuers';
import { buildReceiveNetworksPayload } from '../../config/cryptoNetworks';
import { getStellarConfig } from '../../config/stellarConfig';

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
const DEV_ENCRYPTION_KEY_HEX = 'a'.repeat(64);

type StellarKeypair = ReturnType<typeof StellarSdk.Keypair.fromSecret>;
type StellarHorizonServer = InstanceType<typeof StellarSdk.Horizon.Server>;

type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

type JobRecord = {
  userId: string;
  status: JobStatus;
  current_step: string;
  error: string | null;
  mnemonicPending: string | null;
  recoveryDelivered: boolean;
};

const jobs = new Map<string, JobRecord>();
const provisionLocks = new Map<string, Promise<void>>();

const horizonUrl = () => getStellarConfig().horizonUrl;

const networkPassphrase = () => getStellarConfig().networkPassphrase;

const isStellarTestnet = () => getStellarConfig().isTestnet;

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

function encryptSecret(plain: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(plain, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

function decryptWithKey(keyHex: string, encText: string): string {
  const key = Buffer.from(keyHex, 'hex');
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

function getMasterEncryptionKeyHex(): string | null {
  const fromMaster = process.env.MASTER_WALLET_ENCRYPTION_KEY?.trim();
  if (fromMaster && fromMaster.length === 64 && /^[0-9a-fA-F]+$/.test(fromMaster)) {
    return fromMaster;
  }
  const fromWallet = process.env.WALLET_ENCRYPTION_KEY?.trim();
  if (fromWallet && fromWallet.length === 64 && /^[0-9a-fA-F]+$/.test(fromWallet)) {
    return fromWallet;
  }
  return null;
}

function decryptSecret(encText: string): string {
  const key = getEncryptionKey();
  return decryptWithKey(key.toString('hex'), encText);
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
  if (looksEncrypted) {
    const keyHex = getMasterEncryptionKeyHex();
    if (!keyHex) {
      throw new Error(
        'MASTER_WALLET_ENCRYPTION_KEY or WALLET_ENCRYPTION_KEY required to decrypt MASTER_ENCRYPTED_SECRET_KEY'
      );
    }
    return decryptWithKey(keyHex, value);
  }
  return value;
}

async function loadWalletRow(userId: string): Promise<{
  wallet_id: string;
  stellar_deposit_address: string | null;
  ethereum_deposit_address: string | null;
  stellar_secret_encrypted: string | null;
  ethereum_secret_encrypted: string | null;
  crypto_mnemonic_encrypted: string | null;
} | null> {
  return db.oneOrNone(
    `SELECT wallet_id, stellar_deposit_address, ethereum_deposit_address,
            stellar_secret_encrypted, ethereum_secret_encrypted, crypto_mnemonic_encrypted
     FROM wallets
     WHERE user_id = $1 AND currency = 'USD'
     ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
}

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

/** Generate keys once, persist to DB before any on-chain funding (retries reuse same address). */
async function ensureCryptoKeyMaterial(userId: string): Promise<{
  stellarPublic: string;
  stellarSecret: string;
  ethAddress: string;
  ethSecret: string;
}> {
  const row = await loadWalletRow(userId);
  if (
    row?.stellar_secret_encrypted &&
    row?.ethereum_secret_encrypted &&
    row?.crypto_mnemonic_encrypted
  ) {
    const stellarSecret = decryptSecret(String(row.stellar_secret_encrypted));
    const stellarPublic =
      String(row.stellar_deposit_address || '').trim() ||
      StellarSdk.Keypair.fromSecret(stellarSecret).publicKey();
    return {
      stellarPublic,
      stellarSecret,
      ethAddress: String(row.ethereum_deposit_address || ''),
      ethSecret: decryptSecret(String(row.ethereum_secret_encrypted)),
    };
  }

  const mnemonic = StellarHDWallet.generateMnemonic({ entropyBits: 128 });
  const hd = StellarHDWallet.fromMnemonic(mnemonic);
  const stellarKp = hd.getKeypair(0);
  const stellarPublic = stellarKp.publicKey();
  const stellarSecret = stellarKp.secret();

  const ethWallet = ethers.Wallet.createRandom();
  const ethAddress = ethWallet.address;
  const ethSecret = ethWallet.privateKey;

  await persistCryptoWallet({
    userId,
    stellarPublic,
    stellarSecretEnc: encryptSecret(stellarSecret),
    ethAddress,
    ethSecretEnc: encryptSecret(ethSecret),
    mnemonicEnc: encryptSecret(mnemonic),
  });

  return { stellarPublic, stellarSecret, ethAddress, ethSecret };
}

async function isCryptoFullyProvisioned(userId: string): Promise<boolean> {
  const row = await loadWalletRow(userId);
  if (
    !row?.stellar_deposit_address ||
    !row?.ethereum_deposit_address ||
    !row.stellar_secret_encrypted
  ) {
    return false;
  }

  const server = new StellarSdk.Horizon.Server(horizonUrl());
  try {
    const account = await server.loadAccount(String(row.stellar_deposit_address));
    const assets = buildReceiveTrustlineAssets();
    for (const asset of assets) {
      const has = (
        account.balances as { asset_code?: string; asset_issuer?: string }[]
      ).some(
        (b) =>
          b.asset_code === asset.getCode() &&
          b.asset_issuer === asset.getIssuer()
      );
      if (!has) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const USER_FUNDING_AMOUNT_XLM = '1';

function resolveFundingAmountXlm(): string {
  const raw =
    process.env.STELLAR_FUNDING_AMOUNT_XLM?.trim() ||
    process.env.FUNDING_AMOUNT?.trim();
  const amount = raw && raw.length > 0 ? raw : USER_FUNDING_AMOUNT_XLM;
  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return USER_FUNDING_AMOUNT_XLM;
  }
  // Never send more than 1 XLM to a user's Stellar deposit address.
  return Math.min(parsed, 1).toString();
}

const STELLAR_BASE_RESERVE_XLM = 0.5;

function parseHorizonSubmitError(err: unknown): string {
  const e = err as {
    response?: {
      data?: {
        detail?: string;
        title?: string;
        extras?: {
          result_codes?: {
            transaction?: string;
            operations?: string[];
          };
        };
      };
    };
    message?: string;
  };

  const codes = e?.response?.data?.extras?.result_codes;
  const txCode = codes?.transaction;
  const opCodes = codes?.operations ?? [];
  const masterPk =
    process.env.MASTER_WALLET_PUBLIC_KEY?.trim() || 'master wallet';

  if (
    opCodes.includes('op_underfunded') ||
    txCode === 'tx_insufficient_balance' ||
    txCode === 'tx_insufficient_fee'
  ) {
    return (
      `Stellar master wallet (${masterPk}) has insufficient XLM to fund crypto wallets. ` +
      'Send at least 20 XLM to this address on mainnet, wait a minute, then retry.'
    );
  }

  if (opCodes.length > 0) {
    return `Stellar transaction failed (${txCode ?? 'unknown'}: ${opCodes.join(', ')})`;
  }

  const detail = e?.response?.data?.detail?.trim();
  if (detail) return detail;

  const msg = e?.message?.trim();
  if (msg && !/^request failed with status code \d+$/i.test(msg)) {
    return msg;
  }

  return 'Stellar transaction failed. Check master wallet XLM balance and retry.';
}

async function submitStellarTransaction(
  server: StellarHorizonServer,
  tx: ReturnType<typeof StellarSdk.TransactionBuilder.prototype.build>
): Promise<void> {
  try {
    await server.submitTransaction(tx);
  } catch (err: unknown) {
    throw new Error(parseHorizonSubmitError(err));
  }
}

async function getMasterNativeBalanceXlm(): Promise<number | null> {
  const masterKeypair = resolveMasterKeypair();
  if (!masterKeypair) return null;

  const server = new StellarSdk.Horizon.Server(horizonUrl());
  try {
    const account = await server.loadAccount(masterKeypair.publicKey());
    const native = (
      account.balances as { asset_type?: string; balance?: string }[]
    ).find((b) => b.asset_type === 'native');
    return parseFloat(String(native?.balance || '0'));
  } catch {
    return null;
  }
}

/** Minimum XLM master must hold to fund one new user (createAccount + sponsored trustlines). */
function estimateXlmRequiredForProvision(): number {
  const funding = parseFloat(resolveFundingAmountXlm());
  const trustlineCount = buildReceiveTrustlineAssets().length;
  const sponsorReserves = trustlineCount * STELLAR_BASE_RESERVE_XLM;
  const fees = 0.05;
  return funding + sponsorReserves + STELLAR_BASE_RESERVE_XLM + fees;
}

async function assertMasterCanFundProvision(): Promise<void> {
  if (isStellarTestnet()) return;

  const masterKeypair = resolveMasterKeypair();
  if (!masterKeypair) {
    throw new Error(
      'Mainnet requires MASTER_WALLET_PUBLIC_KEY and MASTER_WALLET_SECRET_KEY to fund new Stellar accounts'
    );
  }

  const balance = await getMasterNativeBalanceXlm();
  const required = estimateXlmRequiredForProvision();
  if (balance === null) {
    throw new Error('Could not read Stellar master wallet balance from Horizon');
  }
  if (balance < required) {
    throw new Error(
      `Stellar master wallet (${masterKeypair.publicKey()}) has ${balance.toFixed(2)} XLM ` +
        `but needs ~${required.toFixed(2)} XLM to provision one user. ` +
        'Send XLM to the master wallet on mainnet and retry.'
    );
  }
}

function resolveMasterKeypair(): StellarKeypair | null {
  const masterPublicKey = process.env.MASTER_WALLET_PUBLIC_KEY?.trim();
  const masterSecretRaw =
    process.env.MASTER_ENCRYPTED_SECRET_KEY?.trim() ||
    process.env.MASTER_WALLET_SECRET_KEY?.trim();
  if (!masterPublicKey || !masterSecretRaw) return null;
  try {
    const masterSecret = decryptMasterSecret(masterSecretRaw);
    const masterKeypair = StellarSdk.Keypair.fromSecret(masterSecret);
    if (masterKeypair.publicKey() !== masterPublicKey) {
      console.warn(
        '[cryptoWalletProvision] MASTER_WALLET_PUBLIC_KEY does not match secret'
      );
    }
    return masterKeypair;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cryptoWalletProvision] Could not load master wallet: ${msg}`);
    return null;
  }
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
  const masterKeypair = resolveMasterKeypair();
  if (!masterKeypair) return false;

  const masterPublicKey = masterKeypair.publicKey();
  const fundingAmount = resolveFundingAmountXlm();

  const server = new StellarSdk.Horizon.Server(horizonUrl());
  const masterAccount = await server.loadAccount(masterPublicKey);

  let destExists = true;
  try {
    await server.loadAccount(userPublicKey);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) destExists = false;
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
    // Retry path: account already funded — never send additional XLM to the user.
    return true;
  }

  const tx = txBuilder.setTimeout(60).build();
  tx.sign(masterKeypair);
  await submitStellarTransaction(server, tx);
  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

async function fundStellarAccount(publicKey: string): Promise<void> {
  if (isStellarTestnet()) {
    const fundedByMaster = await fundFromMasterIfConfigured(publicKey);
    if (!fundedByMaster) {
      await fundWithFriendbot(publicKey);
    }
    return;
  }
  const ok = await fundFromMasterIfConfigured(publicKey);
  if (!ok) {
    throw new Error(
      'Mainnet requires MASTER_WALLET_PUBLIC_KEY and MASTER_WALLET_SECRET_KEY to fund new Stellar accounts'
    );
  }
}

async function addSponsoredTrustline(
  server: StellarHorizonServer,
  masterKeypair: StellarKeypair,
  userKeypair: StellarKeypair,
  asset: InstanceType<typeof StellarSdk.Asset>
): Promise<void> {
  const masterPublicKey = masterKeypair.publicKey();
  const userPublicKey = userKeypair.publicKey();
  const masterAccount = await server.loadAccount(masterPublicKey);
  const fee = String(Number(StellarSdk.BASE_FEE) * 3);

  const tx = new StellarSdk.TransactionBuilder(masterAccount, {
    fee,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.beginSponsoringFutureReserves({
        sponsoredId: userPublicKey,
      })
    )
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: '10000000',
        source: userPublicKey,
      })
    )
    .addOperation(StellarSdk.Operation.endSponsoringFutureReserves())
    .setTimeout(60)
    .build();

  tx.sign(masterKeypair);
  tx.sign(userKeypair);
  await submitStellarTransaction(server, tx);
  await new Promise((r) => setTimeout(r, 800));
}

async function addReceiveTrustlines(stellarSecret: string): Promise<void> {
  const server = new StellarSdk.Horizon.Server(horizonUrl());
  const userKeypair = StellarSdk.Keypair.fromSecret(stellarSecret);
  const userPublicKey = userKeypair.publicKey();
  const assets = buildReceiveTrustlineAssets();
  const masterKeypair = resolveMasterKeypair();

  for (const asset of assets) {
    const account = await server.loadAccount(userPublicKey);
    const already = (account.balances as { asset_code?: string; asset_issuer?: string }[]).some(
      (b) =>
        b.asset_code === asset.getCode() &&
        b.asset_issuer === asset.getIssuer()
    );
    if (already) continue;

    if (masterKeypair) {
      await addSponsoredTrustline(server, masterKeypair, userKeypair, asset);
      continue;
    }

    const nativeBalance = parseFloat(
      String(
        (account.balances as { asset_type?: string; balance?: string }[]).find(
          (b) => b.asset_type === 'native'
        )?.balance || '0'
      )
    );
    if (nativeBalance < 0.5) {
      throw new Error(
        `Insufficient XLM (${nativeBalance}) on ${userPublicKey} to pay trustline fees. ` +
          'Configure MASTER_WALLET_* to sponsor trustlines when STELLAR_FUNDING_AMOUNT_XLM=1.'
      );
    }

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: networkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.changeTrust({
          asset,
          limit: '10000000',
        })
      )
      .setTimeout(60)
      .build();
    tx.sign(userKeypair);
    await submitStellarTransaction(server, tx);
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function runProvisionWork(uid: string): Promise<void> {
  await ensureUsdWalletRow(uid);
  if (await isCryptoFullyProvisioned(uid)) {
    return;
  }

  await assertMasterCanFundProvision();

  const { stellarPublic, stellarSecret } = await ensureCryptoKeyMaterial(uid);

  await fundStellarAccount(stellarPublic);
  await addReceiveTrustlines(stellarSecret);
}

/** Serialize provision attempts per user (concurrent HTTP calls share one chain). */
function queueProvisionForUser(uid: string): Promise<void> {
  const prev = provisionLocks.get(uid) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      // Prior attempt failed; still allow this queued run to retry idempotently.
    })
    .then(() => runProvisionWork(uid));
  provisionLocks.set(uid, next);
  void next.finally(() => {
    if (provisionLocks.get(uid) === next) {
      provisionLocks.delete(uid);
    }
  });
  return next;
}

/** Idempotent: create Stellar + ETH wallets, fund testnet, add USDC/EURC trustlines. */
export async function provisionCryptoWalletsForUser(userId: string): Promise<{
  stellarAddress: string;
  ethereumAddress: string;
}> {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('Invalid user id');

  await queueProvisionForUser(uid);

  const row = await loadWalletRow(uid);
  if (!row?.stellar_deposit_address || !row?.ethereum_deposit_address) {
    throw new Error('Crypto wallet provisioning did not persist addresses');
  }
  if (!(await isCryptoFullyProvisioned(uid))) {
    throw new Error(
      'Crypto wallet provisioning incomplete. Trustlines may still be pending — retry shortly.'
    );
  }
  return {
    stellarAddress: row.stellar_deposit_address,
    ethereumAddress: row.ethereum_deposit_address,
  };
}

function setJob(jobId: string, patch: Partial<JobRecord>) {
  const cur = jobs.get(jobId);
  if (!cur) return;
  jobs.set(jobId, { ...cur, ...patch });
}

async function runJob(jobId: string, userId: string): Promise<void> {
  const steps = [
    'stellar_wallet',
    'ethereum_wallet',
    'fund_stellar',
    'trustlines',
    'finalize',
  ] as const;

  try {
    setJob(jobId, { status: 'processing', current_step: steps[0], error: null });
    await provisionCryptoWalletsForUser(userId);
    setJob(jobId, {
      status: 'completed',
      current_step: 'finalize',
      mnemonicPending: null,
      recoveryDelivered: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
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

  const row = await loadWalletRow(uid);
  if (!row) {
    await ensureUsdWalletRow(uid);
  }
  const after = await loadWalletRow(uid);
  if (after?.stellar_deposit_address && after?.ethereum_deposit_address) {
    if (await isCryptoFullyProvisioned(uid)) {
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

  const ethTokens = resolveEthTokenContracts();
  const base: Record<string, unknown> = {
    status: job.status,
    current_step: job.current_step,
    stellarNetwork: isStellarTestnet() ? 'testnet' : 'mainnet',
    ethereumNetwork: ethTokens.network,
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

export function buildReceiveCryptoPayload(row: {
  stellar_deposit_address: string | null;
  ethereum_deposit_address: string | null;
}) {
  const ethTokens = resolveEthTokenContracts();
  const networks = buildReceiveNetworksPayload({
    stellar: row.stellar_deposit_address,
    evm: row.ethereum_deposit_address,
  });
  return {
    method: 'crypto',
    network: 'stellar',
    assets: ['USDC', 'EURC'],
    stellarAddress: row.stellar_deposit_address,
    ethereumAddress: row.ethereum_deposit_address,
    networks,
    stellarNetwork: isStellarTestnet() ? 'testnet' : 'mainnet',
    ethereumNetwork: ethTokens.network,
    stellarAssets: [
      { code: 'USDC', network: 'stellar' },
      { code: 'EURC', network: 'stellar' },
    ],
    ethereumTokens: {
      USDC: ethTokens.usdc,
      EURC: ethTokens.eurc,
    },
    /** No standard GBP stablecoin on Ethereum testnet/mainnet (unlike USDC/EURC). */
    gbpCryptoSupported: false,
    creditsTo: 'USD',
  };
}

/** Decrypt stored mnemonic for recovery phrase screen (after PIN verified). */
export async function getRecoveryMnemonicForUser(
  userId: string
): Promise<string | null> {
  const row = await db.oneOrNone<{ crypto_mnemonic_encrypted: string | null }>(
    `SELECT crypto_mnemonic_encrypted FROM wallets
     WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [userId]
  );
  const enc = row?.crypto_mnemonic_encrypted;
  if (!enc || !String(enc).trim()) return null;
  try {
    return decryptSecret(String(enc)).trim();
  } catch {
    return null;
  }
}
