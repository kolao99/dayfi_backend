/**
 * Real Stellar TESTNET E2E (no mocks):
 *   provision → send USDC on-chain → syncStellarInflowsToLedger
 *   → ledger_movements → balanceService → checkCryptoDepositStatus
 *   → idempotent re-provision (same address)
 *
 * Usage (API container / VPS):
 *   node -r dotenv/config scripts/stellar-testnet-e2e-deposit-chain.cjs
 *
 * Optional:
 *   DEPOSIT_AMOUNT=5
 *   TARGET_USER_ID=DAYFI-…
 *   SENDER_JSON=/path/to/.testnet-deposit-sender.local.json
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');
const { db } = require('../dist/src/config/database');
const { getStellarConfig } = require('../dist/src/config/stellarConfig');
const {
  resolveUsdcIssuer,
} = require('../dist/src/config/stellarIssuers');
const {
  getPersistedCryptoDepositAddresses,
  isUserCryptoWalletReady,
  provisionCryptoWalletsForUser,
} = require('../dist/src/modules/payment/cryptoWalletProvision');
const {
  syncStellarInflowsToLedger,
} = require('../dist/src/modules/payment/cryptoInflowSyncService');
const {
  buildBalanceReply,
} = require('../dist/src/modules/four/finance/balanceService');
const {
  checkCryptoDepositStatus,
} = require('../dist/src/modules/four/finance/cryptoDepositFlow');
const PaymentService = require('../dist/src/modules/payment/services').default;

const AMOUNT = Number(process.env.DEPOSIT_AMOUNT || '5');
const SENDER_JSON =
  process.env.SENDER_JSON ||
  path.join(__dirname, '..', '.testnet-deposit-sender.local.json');

function log(section, data) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function loadOrCreateSender() {
  if (process.env.SENDER_SECRET && process.env.SENDER_PUBLIC_KEY) {
    return {
      publicKey: process.env.SENDER_PUBLIC_KEY.trim(),
      secret: process.env.SENDER_SECRET.trim(),
    };
  }
  if (fs.existsSync(SENDER_JSON)) {
    const saved = JSON.parse(fs.readFileSync(SENDER_JSON, 'utf8'));
    if (saved.secret && /^S[A-Z0-9]{55}$/.test(saved.secret)) return saved;
  }
  const kp = StellarSdk.Keypair.random();
  const payload = {
    publicKey: kp.publicKey(),
    secret: kp.secret(),
    network: 'testnet',
  };
  try {
    fs.writeFileSync(SENDER_JSON, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
  } catch (_) {
    /* container may be read-only for that path */
  }
  return payload;
}

async function friendbot(publicKey) {
  const cfg = getStellarConfig();
  const res = await fetch(
    `${cfg.friendbotUrl}?addr=${encodeURIComponent(publicKey)}`
  );
  if (!res.ok) {
    const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
    await server.loadAccount(publicKey);
    return;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

async function ensureUsdcTrustline(publicKey, secret) {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const issuer = resolveUsdcIssuer(true);
  const asset = new StellarSdk.Asset('USDC', issuer);
  const account = await server.loadAccount(publicKey);
  const has = account.balances.some(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer
  );
  if (has) return;
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({ asset, limit: '1000000000' })
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
  await new Promise((r) => setTimeout(r, 1000));
}

async function accountUsdc(publicKey) {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const issuer = resolveUsdcIssuer(true);
    const row = account.balances.find(
      (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer
    );
    return parseFloat(String(row?.balance || '0')) || 0;
  } catch {
    return 0;
  }
}

async function claimSozuFaucet(publicKey) {
  // Prefer Sozu CLI when available; otherwise try public faucet HTTP if present.
  const { spawnSync } = require('child_process');
  const tryNpx = spawnSync(
    'npx',
    ['--yes', '@sozu/faucet', 'claim', publicKey],
    { encoding: 'utf8', timeout: 120_000 }
  );
  if (tryNpx.status === 0) {
    return { ok: true, via: 'sozu-cli', stdout: tryNpx.stdout.slice(0, 500) };
  }
  return {
    ok: false,
    via: 'sozu-cli',
    stderr: (tryNpx.stderr || tryNpx.error?.message || '').slice(0, 800),
  };
}

async function sendUsdc({ secret, destination, amount }) {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const kp = StellarSdk.Keypair.fromSecret(secret);
  const issuer = resolveUsdcIssuer(true);
  const asset = new StellarSdk.Asset('USDC', issuer);
  const account = await server.loadAccount(kp.publicKey());
  const amt = (Math.round(amount * 1e7) / 1e7)
    .toFixed(7)
    .replace(/\.?0+$/, '');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset,
        amount: amt,
      })
    )
    .addMemo(StellarSdk.Memo.text('azap-e2e-deposit'))
    .setTimeout(180)
    .build();
  tx.sign(kp);
  const result = await server.submitTransaction(tx);
  return String(result.hash);
}

async function ensureDayfiUser(existingId) {
  if (existingId) {
    const row = await db.oneOrNone(
      `SELECT user_id FROM users WHERE user_id = $1`,
      [existingId]
    );
    if (!row) throw new Error(`TARGET_USER_ID not found: ${existingId}`);
    return existingId;
  }
  const phone = `+1555${Date.now().toString().slice(-9)}`;
  const row = await db.one(
    `INSERT INTO users (first_name, last_name, phone_e164, status, level, phone_verified)
     VALUES ($1, $2, $3, 'active', 'level-0', false)
     RETURNING user_id`,
    ['E2E', 'Deposit', phone]
  );
  return row.user_id;
}

async function ledgerCredits(userId) {
  return db.any(
    `SELECT id::text, amount, currency, usd_equivalent, source, metadata, created_at
       FROM ledger_movements
      WHERE user_id = $1 AND direction = 'credit' AND source = 'stellar'
      ORDER BY created_at DESC
      LIMIT 10`,
    [userId]
  );
}

async function usdWalletBalance(userId) {
  const row = await db.oneOrNone(
    `SELECT wallet_id, balance, stellar_deposit_address
       FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [userId]
  );
  return row;
}

async function main() {
  const cfg = getStellarConfig();
  if (!cfg.isTestnet) {
    throw new Error(`Refusing: STELLAR_NETWORK=${cfg.network}`);
  }
  if (!(AMOUNT > 0) || AMOUNT > 1000) {
    throw new Error(`Bad DEPOSIT_AMOUNT=${AMOUNT}`);
  }

  const report = {
    network: cfg.network,
    horizon: cfg.horizonUrl,
    usdcIssuer: resolveUsdcIssuer(true),
    amount: AMOUNT,
    success: false,
  };

  const paymentService = new PaymentService();
  const userId = await ensureDayfiUser(process.env.TARGET_USER_ID || '');
  report.userId = userId;

  await paymentService.ensureUserLedgerWallets(userId);

  const provisioned = await provisionCryptoWalletsForUser(userId);
  const ready = await isUserCryptoWalletReady(userId);
  const persisted = await getPersistedCryptoDepositAddresses(userId);
  report.provision = {
    stellarAddress: provisioned.stellarAddress,
    ethereumAddress: provisioned.ethereumAddress,
    ready,
    persistedMatches: persisted.stellar === provisioned.stellarAddress,
  };
  log('Provision', report.provision);

  if (!provisioned.stellarAddress) {
    throw new Error('No stellar deposit address after provision');
  }

  // Idempotent re-provision BEFORE deposit (address must not change).
  const againBefore = await provisionCryptoWalletsForUser(userId);
  report.idempotentBeforeDeposit = {
    sameAddress:
      againBefore.stellarAddress === provisioned.stellarAddress,
    address: againBefore.stellarAddress,
  };
  if (!report.idempotentBeforeDeposit.sameAddress) {
    throw new Error('Re-provision created a different Stellar address');
  }

  const walletBefore = await usdWalletBalance(userId);
  const balanceBefore = await buildBalanceReply(userId);
  report.before = {
    usdBalance: walletBefore?.balance,
    balanceReply: balanceBefore.content,
  };
  log('Before deposit', report.before);

  const sender = loadOrCreateSender();
  report.senderPublicKey = sender.publicKey;
  await friendbot(sender.publicKey);
  await ensureUsdcTrustline(sender.publicKey, sender.secret);

  let senderUsdc = await accountUsdc(sender.publicKey);
  report.senderUsdcBefore = senderUsdc;
  if (senderUsdc + 1e-7 < AMOUNT) {
    log('Sender low on USDC — claiming Sozu faucet', {
      publicKey: sender.publicKey,
      have: senderUsdc,
      need: AMOUNT,
    });
    const claim = await claimSozuFaucet(sender.publicKey);
    report.sozuClaim = claim;
    await new Promise((r) => setTimeout(r, 4000));
    senderUsdc = await accountUsdc(sender.publicKey);
    report.senderUsdcAfterClaim = senderUsdc;
  }

  if (senderUsdc + 1e-7 < AMOUNT) {
    report.blocked = true;
    report.blockReason = `Sender has ${senderUsdc} USDC; need ${AMOUNT}. Fund ${sender.publicKey} via Circle/Sozu faucet.`;
    log('FINAL REPORT (BLOCKED)', report);
    process.exit(2);
  }

  const txHash = await sendUsdc({
    secret: sender.secret,
    destination: provisioned.stellarAddress,
    amount: AMOUNT,
  });
  report.txHash = txHash;
  report.horizonTx = `https://stellar.expert/explorer/testnet/tx/${txHash}`;
  log('On-chain payment submitted', { txHash, amount: AMOUNT });

  // Give Horizon a moment to index effects.
  await new Promise((r) => setTimeout(r, 3000));

  const wallets = await paymentService.getWalletsByUserId(userId);
  const walletsByCurrency = {};
  for (const w of wallets) {
    walletsByCurrency[String(w.currency).toUpperCase()] = {
      wallet_id: w.wallet_id,
      currency: w.currency,
    };
  }

  const sync = await syncStellarInflowsToLedger({
    userId,
    walletsByCurrency,
  });
  report.sync = sync;
  log('syncStellarInflowsToLedger', sync);

  const credits = await ledgerCredits(userId);
  const walletAfter = await usdWalletBalance(userId);
  const balanceAfter = await buildBalanceReply(userId);
  report.after = {
    usdBalance: walletAfter?.balance,
    balanceReply: balanceAfter.content,
    recentStellarCredits: credits.slice(0, 3),
  };
  log('After sync / balance', report.after);

  const status = await checkCryptoDepositStatus({
    userId,
    asset: 'USDC',
    network: 'stellar',
    expectedAmount: AMOUNT,
    depositAddress: provisioned.stellarAddress,
  });
  report.azapDepositStatus = status;
  log('Azap checkCryptoDepositStatus', status);

  // Idempotent re-provision AFTER deposit.
  const againAfter = await provisionCryptoWalletsForUser(userId);
  const persistedAfter = await getPersistedCryptoDepositAddresses(userId);
  report.idempotentAfterDeposit = {
    sameAddress: againAfter.stellarAddress === provisioned.stellarAddress,
    persistedSame: persistedAfter.stellar === provisioned.stellarAddress,
  };

  const usdAfter = Number(walletAfter?.balance || 0);
  const usdBefore = Number(walletBefore?.balance || 0);
  const creditedFresh = Number(sync.credited || 0) > 0;
  const expectedAfter = usdBefore + AMOUNT;
  const deltaOk = Math.abs(usdAfter - expectedAfter) < 0.02;
  // Must not double-credit the same on-chain transfer.
  const noDoubleCredit = Number(sync.credited || 0) === 1;
  const statusOk = status.status === 'CONFIRMED';
  const balanceMentions =
    /USDC|available|balance/i.test(balanceAfter.content) &&
    !balanceAfter.failed;

  report.checks = {
    syncCredited: creditedFresh,
    noDoubleCredit,
    ledgerDeltaMatchesAmount: deltaOk,
    balanceServiceReflectsLedger:
      balanceMentions && Math.abs(usdAfter - expectedAfter) < 0.02,
    azapStatusConfirmed: statusOk,
    addressIdempotent:
      report.idempotentBeforeDeposit.sameAddress &&
      report.idempotentAfterDeposit.sameAddress,
  };

  report.success = Object.values(report.checks).every(Boolean);
  log('FINAL REPORT', report);

  if (!report.success) {
    process.exit(1);
  }
  await db.$pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.$pool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
