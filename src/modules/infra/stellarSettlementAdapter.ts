/**
 * Phase 5 — Stellar settlement adapter (RPC-first).
 *
 * Classic USDC payment: build → sign → RPC sendTransaction → poll getTransaction.
 * Horizon is not the primary interaction API.
 *
 * Modes:
 *   mock — deterministic fake hash (tests / CI; default)
 *   live — real Testnet/Mainnet RPC (requires DAYFI_STELLAR_SETTLEMENT_SECRET)
 */

import StellarSdk from '@stellar/stellar-sdk';
import crypto from 'crypto';
import { getStellarConfig } from '../../config/stellarConfig';
import { resolveUsdcIssuer } from '../../config/stellarIssuers';

export type StellarPaymentInput = {
  destination: string;
  amount: string | number;
  memo?: string;
  /** Optional override of the signing secret (org wallet / treasury). */
  sourceSecret?: string;
};

export type SponsoredUsdcPaymentInput = StellarPaymentInput & {
  /** Alice org wallet secret — USDC source. Never the fee payer. */
  sourceSecret: string;
  /** Dayfi XLM fee-payer secret — pays network fee only. */
  feePayerSecret: string;
};

export type SponsoredUsdcPaymentResult = StellarPaymentResult & {
  feePayerPublicKey: string;
  innerSourcePublicKey: string;
  actualNetworkFeeXlm: string | null;
  actualNetworkFeeStroops: string | null;
  envelopeType: 'FEE_BUMP';
};

export type PreparedSponsoredPayment = {
  xdr: string;
  transactionHash: string;
  innerSourcePublicKey: string;
  feePayerPublicKey: string;
  destinationAccount: string;
  amount: string;
  envelopeType: 'FEE_BUMP';
};

export type StellarPaymentResult = {
  mode: 'mock' | 'live';
  transactionHash: string;
  ledgerSequence: number | null;
  operationId: string | null;
  sourceAccount: string;
  destinationAccount: string;
  asset: 'USDC';
  amount: string;
  networkPassphrase: string;
  rpcUrl: string | null;
  raw?: Record<string, unknown>;
};

export class StellarSettlementAdapterError extends Error {
  code: string;

  constructor(message: string, code = 'STELLAR_ADAPTER_ERROR') {
    super(message);
    this.name = 'StellarSettlementAdapterError';
    this.code = code;
  }
}

export function getStellarSettlementMode(): 'mock' | 'live' {
  const raw = String(process.env.DAYFI_STELLAR_SETTLEMENT_MODE || '')
    .trim()
    .toLowerCase();
  if (raw === 'live' || raw === 'mock') return raw;
  return 'mock';
}

function rpcUrl(isTestnet: boolean): string {
  const fromEnv =
    process.env.DAYFI_STELLAR_RPC_URL?.trim() ||
    process.env.STELLAR_RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  return isTestnet
    ? 'https://soroban-testnet.stellar.org'
    : 'https://mainnet.sorobanrpc.com';
}

function sourceSecret(override?: string): string {
  const secret =
    override?.trim() ||
    process.env.DAYFI_STELLAR_SETTLEMENT_SECRET?.trim() ||
    process.env.MASTER_WALLET_SECRET_KEY?.trim() ||
    '';
  if (!secret) {
    throw new StellarSettlementAdapterError(
      'DAYFI_STELLAR_SETTLEMENT_SECRET (or MASTER_WALLET_SECRET_KEY) required for live mode',
      'MISSING_SECRET'
    );
  }
  return secret;
}

function assertGAddress(addr: string, label: string): string {
  const a = String(addr || '').trim();
  if (!/^G[A-Z0-9]{55}$/.test(a)) {
    throw new StellarSettlementAdapterError(
      `Invalid Stellar ${label} address`,
      'INVALID_ADDRESS'
    );
  }
  return a;
}

function formatUsdcAmount(amount: string | number): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new StellarSettlementAdapterError('Amount must be positive', 'INVALID_AMOUNT');
  }
  const fixed = (Math.round(n * 1e7) / 1e7).toFixed(7);
  return fixed.replace(/\.?0+$/, '') || String(n);
}

/** Horizon fallback when Soroban RPC returns unparsable classic payment status. */
async function verifyOnHorizon(transactionHash: string): Promise<{
  confirmed: boolean;
  status: string;
  ledgerSequence: number | null;
  raw?: Record<string, unknown>;
}> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const tx = await server.transactions().transaction(transactionHash).call();
    return {
      confirmed: tx.successful === true,
      status: tx.successful ? 'SUCCESS' : 'FAILED',
      ledgerSequence: typeof tx.ledger === 'number' ? tx.ledger : null,
      raw: { source: 'horizon', hash: tx.hash, successful: tx.successful },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      confirmed: false,
      status: 'NOT_FOUND',
      ledgerSequence: null,
      raw: { source: 'horizon', error: message },
    };
  }
}

function mockPayment(input: StellarPaymentInput): StellarPaymentResult {
  const cfg = getStellarConfig();
  const dest = assertGAddress(input.destination, 'destination');
  const amount = formatUsdcAmount(input.amount);
  let sourceAccount = `G${'A'.repeat(55)}`;
  try {
    if (input.sourceSecret) {
      sourceAccount = StellarSdk.Keypair.fromSecret(
        input.sourceSecret.trim()
      ).publicKey();
    } else if (process.env.DAYFI_STELLAR_SETTLEMENT_SECRET) {
      sourceAccount = StellarSdk.Keypair.fromSecret(
        sourceSecret(input.sourceSecret)
      ).publicKey();
    }
  } catch {
    /* placeholder source */
  }
  const seed = `${sourceAccount}:${dest}:${amount}:${input.memo || ''}`;
  const transactionHash = crypto.createHash('sha256').update(seed).digest('hex');
  return {
    mode: 'mock',
    transactionHash,
    ledgerSequence: 1,
    operationId: `${transactionHash}:0`,
    sourceAccount,
    destinationAccount: dest,
    asset: 'USDC',
    amount,
    networkPassphrase: cfg.networkPassphrase,
    rpcUrl: null,
    raw: { mock: true },
  };
}

async function livePayment(input: StellarPaymentInput): Promise<StellarPaymentResult> {
  const cfg = getStellarConfig();
  const url = rpcUrl(cfg.isTestnet);
  const keypair = StellarSdk.Keypair.fromSecret(sourceSecret(input.sourceSecret));
  const dest = assertGAddress(input.destination, 'destination');
  const amount = formatUsdcAmount(input.amount);
  const asset = new StellarSdk.Asset('USDC', resolveUsdcIssuer(cfg.isTestnet));

  const server = new StellarSdk.rpc.Server(url, {
    allowHttp: url.startsWith('http://'),
  });

  let account;
  try {
    account = await server.getAccount(keypair.publicKey());
  } catch (err: any) {
    throw new StellarSettlementAdapterError(
      `Unable to load source account via RPC: ${err?.message || err}`,
      'ACCOUNT_LOAD_FAILED'
    );
  }

  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  }).addOperation(
    StellarSdk.Operation.payment({
      destination: dest,
      asset,
      amount,
    })
  );

  const memo = String(input.memo || '').trim();
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo.substring(0, 28)));

  const tx = builder.setTimeout(180).build();
  tx.sign(keypair);

  let sendReply: any;
  try {
    sendReply = await server.sendTransaction(tx);
  } catch (err: any) {
    throw new StellarSettlementAdapterError(
      `RPC sendTransaction failed: ${err?.message || err}`,
      'SUBMIT_FAILED'
    );
  }

  if (sendReply?.status === 'ERROR') {
    throw new StellarSettlementAdapterError(
      `RPC rejected transaction: ${sendReply.errorResultXdr || sendReply.status}`,
      'SUBMIT_REJECTED'
    );
  }

  const hash = String(sendReply?.hash || tx.hash().toString('hex'));
  let ledgerSequence: number | null = null;
  let finalStatus = String(sendReply?.status || 'PENDING');

  try {
    const polled: any = await server.pollTransaction(hash, {
      attempts: 24,
      sleepStrategy: () => 500,
    });
    finalStatus = String(polled?.status || finalStatus);
    const successStatuses = new Set([
      'SUCCESS',
      StellarSdk.rpc?.Api?.GetTransactionStatus?.SUCCESS,
    ].filter(Boolean));
    const failedStatuses = new Set([
      'FAILED',
      StellarSdk.rpc?.Api?.GetTransactionStatus?.FAILED,
    ].filter(Boolean));

    if (successStatuses.has(finalStatus)) {
      ledgerSequence = typeof polled.ledger === 'number' ? polled.ledger : null;
    } else if (failedStatuses.has(finalStatus)) {
      throw new StellarSettlementAdapterError(
        'Stellar transaction failed on-chain',
        'TX_FAILED'
      );
    }
  } catch (err: any) {
    if (err instanceof StellarSettlementAdapterError) throw err;
    finalStatus = 'SUBMITTED_UNCONFIRMED';
  }

  if (ledgerSequence == null) {
    const horizon = await verifyOnHorizon(hash);
    if (horizon.confirmed) {
      ledgerSequence = horizon.ledgerSequence;
      finalStatus = 'SUCCESS';
    }
  }

  return {
    mode: 'live',
    transactionHash: hash,
    ledgerSequence,
    operationId: `${hash}:0`,
    sourceAccount: keypair.publicKey(),
    destinationAccount: dest,
    asset: 'USDC',
    amount,
    networkPassphrase: cfg.networkPassphrase,
    rpcUrl: url,
    raw: { sendStatus: sendReply?.status, finalStatus },
  };
}

export async function submitUsdcPayment(
  input: StellarPaymentInput
): Promise<StellarPaymentResult> {
  if (getStellarSettlementMode() === 'mock') return mockPayment(input);
  return livePayment(input);
}

function stroopsToXlm(stroops: string | number | null | undefined): string | null {
  if (stroops == null || stroops === '') return null;
  const n = BigInt(String(Math.trunc(Number(stroops))));
  const whole = n / BigInt(10000000);
  const frac = (n % BigInt(10000000)).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

async function loadHorizonFeeCharged(hash: string): Promise<{
  stroops: string | null;
  feeAccount: string | null;
}> {
  const cfg = getStellarConfig();
  const server = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  try {
    const tx = await server.transactions().transaction(hash).call();
    const feeAccount =
      (tx as { fee_account?: string }).fee_account ||
      (tx as { fee_bump_transaction?: { fee_source?: string } }).fee_bump_transaction
        ?.fee_source ||
      null;
    return {
      stroops: tx.fee_charged != null ? String(tx.fee_charged) : null,
      feeAccount,
    };
  } catch {
    return { stroops: null, feeAccount: null };
  }
}

function mockSponsoredPayment(
  input: SponsoredUsdcPaymentInput
): SponsoredUsdcPaymentResult {
  const alice = StellarSdk.Keypair.fromSecret(input.sourceSecret.trim());
  const feePayer = StellarSdk.Keypair.fromSecret(input.feePayerSecret.trim());
  if (alice.publicKey() === feePayer.publicKey()) {
    throw new StellarSettlementAdapterError(
      'Fee payer cannot be the USDC source',
      'FEE_PAYER_IS_SOURCE'
    );
  }
  const dest = assertGAddress(input.destination, 'destination');
  if (dest === alice.publicKey()) {
    throw new StellarSettlementAdapterError(
      'Cannot send to the source account',
      'SELF_TRANSFER'
    );
  }
  const amount = formatUsdcAmount(input.amount);
  const seed = `feebump:${alice.publicKey()}:${dest}:${amount}:${input.memo || ''}:${feePayer.publicKey()}`;
  const transactionHash = crypto.createHash('sha256').update(seed).digest('hex');
  return {
    mode: 'mock',
    transactionHash,
    ledgerSequence: 1,
    operationId: `${transactionHash}:0`,
    sourceAccount: alice.publicKey(),
    destinationAccount: dest,
    asset: 'USDC',
    amount,
    networkPassphrase: getStellarConfig().networkPassphrase,
    rpcUrl: null,
    feePayerPublicKey: feePayer.publicKey(),
    innerSourcePublicKey: alice.publicKey(),
    actualNetworkFeeXlm: '0.00001',
    actualNetworkFeeStroops: '100',
    envelopeType: 'FEE_BUMP',
    raw: {
      mock: true,
      envelopeType: 'FEE_BUMP',
      usdcSource: alice.publicKey(),
      feePayer: feePayer.publicKey(),
    },
  };
}

function assertDistinctFeePayer(
  alicePk: string,
  feePayerPk: string,
  dest: string
): void {
  if (alicePk === feePayerPk) {
    throw new StellarSettlementAdapterError(
      'Fee payer cannot be the USDC source',
      'FEE_PAYER_IS_SOURCE'
    );
  }
  if (dest === alicePk) {
    throw new StellarSettlementAdapterError(
      'Cannot send to the source account',
      'SELF_TRANSFER'
    );
  }
}

/**
 * Sign the inner Alice USDC payment and wrap it in a fee-bump XDR.
 * Does not submit. Persist the XDR, then submit the same envelope on retry.
 */
export async function prepareSponsoredUsdcPayment(
  input: SponsoredUsdcPaymentInput
): Promise<PreparedSponsoredPayment> {
  const alice = StellarSdk.Keypair.fromSecret(input.sourceSecret.trim());
  const feePayer = StellarSdk.Keypair.fromSecret(input.feePayerSecret.trim());
  const dest = assertGAddress(input.destination, 'destination');
  assertDistinctFeePayer(alice.publicKey(), feePayer.publicKey(), dest);
  const amount = formatUsdcAmount(input.amount);

  if (getStellarSettlementMode() === 'mock') {
    const preview = mockSponsoredPayment(input);
    return {
      xdr: `mock-feebump:${preview.transactionHash}`,
      transactionHash: preview.transactionHash,
      innerSourcePublicKey: preview.innerSourcePublicKey,
      feePayerPublicKey: preview.feePayerPublicKey,
      destinationAccount: dest,
      amount,
      envelopeType: 'FEE_BUMP',
    };
  }

  const cfg = getStellarConfig();
  if (!cfg.isTestnet) {
    throw new StellarSettlementAdapterError(
      'Sponsored org-to-org USDC is Testnet-only in E-ONCHAIN',
      'MAINNET_BLOCKED'
    );
  }
  const asset = new StellarSdk.Asset('USDC', resolveUsdcIssuer(true));
  const horizon = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  let account;
  try {
    account = await horizon.loadAccount(alice.publicKey());
  } catch (err: any) {
    throw new StellarSettlementAdapterError(
      `Unable to load Alice account: ${err?.message || err}`,
      'ACCOUNT_LOAD_FAILED'
    );
  }

  const innerBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  }).addOperation(
    StellarSdk.Operation.payment({
      destination: dest,
      asset,
      amount,
    })
  );
  const memo = String(input.memo || '').trim();
  if (memo) innerBuilder.addMemo(StellarSdk.Memo.text(memo.substring(0, 28)));
  const inner = innerBuilder.setTimeout(180).build();
  inner.sign(alice);

  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    feePayer,
    StellarSdk.BASE_FEE,
    inner,
    cfg.networkPassphrase
  );
  feeBump.sign(feePayer);

  return {
    xdr: feeBump.toXDR(),
    transactionHash: feeBump.hash().toString('hex'),
    innerSourcePublicKey: alice.publicKey(),
    feePayerPublicKey: feePayer.publicKey(),
    destinationAccount: dest,
    amount,
    envelopeType: 'FEE_BUMP',
  };
}

export async function submitPreparedSponsoredPayment(
  prepared: PreparedSponsoredPayment
): Promise<SponsoredUsdcPaymentResult> {
  if (String(process.env.DAYFI_INFRA_ONCHAIN_FORCE_FAIL || '') === '1') {
    throw new StellarSettlementAdapterError(
      'Forced Stellar submit failure',
      'SUBMIT_FAILED'
    );
  }
  if (getStellarSettlementMode() === 'mock') {
    return {
      mode: 'mock',
      transactionHash: prepared.transactionHash,
      ledgerSequence: 1,
      operationId: `${prepared.transactionHash}:0`,
      sourceAccount: prepared.innerSourcePublicKey,
      destinationAccount: prepared.destinationAccount,
      asset: 'USDC',
      amount: prepared.amount,
      networkPassphrase: getStellarConfig().networkPassphrase,
      rpcUrl: null,
      feePayerPublicKey: prepared.feePayerPublicKey,
      innerSourcePublicKey: prepared.innerSourcePublicKey,
      actualNetworkFeeXlm: '0.00001',
      actualNetworkFeeStroops: '100',
      envelopeType: 'FEE_BUMP',
      raw: {
        mock: true,
        envelopeType: 'FEE_BUMP',
        usdcSource: prepared.innerSourcePublicKey,
        feePayer: prepared.feePayerPublicKey,
      },
    };
  }

  const cfg = getStellarConfig();
  const horizon = new StellarSdk.Horizon.Server(cfg.horizonUrl);
  const parsed = StellarSdk.TransactionBuilder.fromXDR(
    prepared.xdr,
    cfg.networkPassphrase
  );
  let result: any;
  try {
    result = await horizon.submitTransaction(parsed);
  } catch (err: any) {
    const extras = err?.response?.data?.extras;
    const codes = extras?.result_codes
      ? JSON.stringify(extras.result_codes)
      : err?.message || err;
    const already =
      String(codes).includes('tx_duplicate') ||
      String(err?.message || '').toLowerCase().includes('duplicate');
    if (!already) {
      throw new StellarSettlementAdapterError(
        `Fee-bump submit failed: ${codes}`.slice(0, 500),
        'SUBMIT_FAILED'
      );
    }
    result = { hash: prepared.transactionHash };
  }

  const hash = String(result.hash || prepared.transactionHash);
  let feeCharged = result.fee_charged != null ? String(result.fee_charged) : null;
  let feeAccount: string | null = null;
  if (!feeCharged) {
    const observed = await loadHorizonFeeCharged(hash);
    feeCharged = observed.stroops;
    feeAccount = observed.feeAccount;
  }
  if (
    feeAccount &&
    feeAccount !== prepared.feePayerPublicKey
  ) {
    throw new StellarSettlementAdapterError(
      'Confirmed fee account is not the Dayfi fee-payer',
      'FEE_PAYER_MISMATCH'
    );
  }

  return {
    mode: 'live',
    transactionHash: hash,
    ledgerSequence:
      typeof result.ledger === 'number' ? result.ledger : null,
    operationId: `${hash}:0`,
    sourceAccount: prepared.innerSourcePublicKey,
    destinationAccount: prepared.destinationAccount,
    asset: 'USDC',
    amount: prepared.amount,
    networkPassphrase: cfg.networkPassphrase,
    rpcUrl: null,
    feePayerPublicKey: prepared.feePayerPublicKey,
    innerSourcePublicKey: prepared.innerSourcePublicKey,
    actualNetworkFeeXlm: stroopsToXlm(feeCharged),
    actualNetworkFeeStroops: feeCharged,
    envelopeType: 'FEE_BUMP',
    raw: {
      envelopeType: 'FEE_BUMP',
      usdcSource: prepared.innerSourcePublicKey,
      feePayer: prepared.feePayerPublicKey,
      successful: result.successful === true,
    },
  };
}

/**
 * Classic USDC payment signed by Alice, wrapped in a Stellar fee-bump
 * whose source is the Dayfi XLM fee-paying account.
 *
 * Inner: source = Alice, operation = payment(USDC → Bob)
 * Outer: fee source = Dayfi (pays XLM). Dayfi is NOT the USDC source.
 */
export async function submitSponsoredUsdcPayment(
  input: SponsoredUsdcPaymentInput
): Promise<SponsoredUsdcPaymentResult> {
  const prepared = await prepareSponsoredUsdcPayment(input);
  return submitPreparedSponsoredPayment(prepared);
}

export async function verifyUsdcPayment(transactionHash: string): Promise<{
  confirmed: boolean;
  status: string;
  ledgerSequence: number | null;
  raw?: Record<string, unknown>;
}> {
  if (getStellarSettlementMode() === 'mock') {
    return {
      confirmed: true,
      status: 'SUCCESS',
      ledgerSequence: 1,
      raw: { mock: true, transactionHash },
    };
  }

  const cfg = getStellarConfig();
  const url = rpcUrl(cfg.isTestnet);
  const server = new StellarSdk.rpc.Server(url, {
    allowHttp: url.startsWith('http://'),
  });
  try {
    const tx: any = await server.getTransaction(transactionHash);
    const status = String(tx.status || '');
    const confirmed =
      status === 'SUCCESS' ||
      status === StellarSdk.rpc?.Api?.GetTransactionStatus?.SUCCESS;
    return {
      confirmed,
      status,
      ledgerSequence: typeof tx.ledger === 'number' ? tx.ledger : null,
      raw: tx,
    };
  } catch {
    return verifyOnHorizon(transactionHash);
  }
}
