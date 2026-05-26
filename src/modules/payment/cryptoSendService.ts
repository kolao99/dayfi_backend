/**
 * On-chain send (custodial Stellar + Ethereum USDC/EURC).
 * @see dayfi.wallet backend walletService.sendAsset + evmWalletService
 */
import StellarSdk from '@stellar/stellar-sdk';
import { ethers } from 'ethers';
import { db } from '../../config/database';
import {
  isStellarTestnet,
  resolveEthTokenContracts,
  resolveEurcIssuer,
  resolveUsdcIssuer,
} from '../../config/stellarIssuers';
import { decryptWalletSecret } from './cryptoWalletSecrets';

const horizonUrl = () =>
  process.env.STELLAR_HORIZON_URL ||
  (isStellarTestnet()
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org');

const networkPassphrase = () =>
  isStellarTestnet() ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;

function stellarAsset(code: string) {
  const c = code.toUpperCase();
  if (c === 'USDC') return new StellarSdk.Asset('USDC', resolveUsdcIssuer());
  if (c === 'EURC') return new StellarSdk.Asset('EURC', resolveEurcIssuer());
  throw new Error(`Unsupported Stellar asset: ${code}`);
}

async function loadCryptoRow(userId: string) {
  return db.oneOrNone<{
    stellar_deposit_address: string | null;
    stellar_secret_encrypted: string | null;
    ethereum_deposit_address: string | null;
    ethereum_secret_encrypted: string | null;
  }>(
    `SELECT stellar_deposit_address, stellar_secret_encrypted,
            ethereum_deposit_address, ethereum_secret_encrypted
     FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1`,
    [userId]
  );
}

export function getCryptoSendConfig() {
  return {
    networks: [
      { key: 'stellar', name: 'Stellar', assets: ['USDC', 'EURC'] },
      { key: 'ethereum', name: 'Ethereum', assets: ['USDC', 'EURC'] },
    ],
    assets: {
      USDC: ['stellar', 'ethereum'],
      EURC: ['stellar', 'ethereum'],
    },
  };
}

export async function sendStellarAsset(params: {
  userId: string;
  toAddress: string;
  amount: string;
  assetCode: string;
  memo?: string;
}): Promise<{ hash: string; from: string; to: string }> {
  const row = await loadCryptoRow(params.userId);
  if (!row?.stellar_secret_encrypted || !row.stellar_deposit_address) {
    throw new Error('Stellar wallet not provisioned. Open Receive → Crypto first.');
  }

  const secret = decryptWalletSecret(row.stellar_secret_encrypted);
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const asset = stellarAsset(params.assetCode);
  const dest = params.toAddress.trim();
  if (!/^G[A-Z0-9]{55}$/.test(dest)) {
    throw new Error('Invalid Stellar address (must start with G)');
  }

  const server = new StellarSdk.Horizon.Server(horizonUrl());
  const senderAccount = await server.loadAccount(keypair.publicKey());
  const txBuilder = new StellarSdk.TransactionBuilder(senderAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: networkPassphrase(),
  });

  let destExists = true;
  try {
    await server.loadAccount(dest);
  } catch {
    destExists = false;
  }

  if (!destExists) {
    txBuilder.addOperation(
      StellarSdk.Operation.createAccount({
        destination: dest,
        startingBalance: '1',
      })
    );
  } else {
    txBuilder.addOperation(
      StellarSdk.Operation.payment({
        destination: dest,
        asset,
        amount: params.amount,
      })
    );
  }

  const memo = (params.memo || '').trim();
  if (memo) txBuilder.addMemo(StellarSdk.Memo.text(memo.substring(0, 28)));

  const tx = txBuilder.setTimeout(60).build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);

  return {
    hash: result.hash,
    from: keypair.publicKey(),
    to: dest,
  };
}

function resolveEthRpc(): string {
  const contracts = resolveEthTokenContracts();
  const fromEnv = process.env.ETH_RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  if (contracts.network === 'sepolia') {
    return 'https://ethereum-sepolia.publicnode.com';
  }
  return 'https://ethereum.publicnode.com';
}

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export async function sendEthereumToken(params: {
  userId: string;
  toAddress: string;
  amount: string;
  assetCode: string;
}): Promise<{ hash: string; from: string; to: string }> {
  const row = await loadCryptoRow(params.userId);
  if (!row?.ethereum_secret_encrypted || !row.ethereum_deposit_address) {
    throw new Error('Ethereum wallet not provisioned. Open Receive → Crypto first.');
  }

  const to = params.toAddress.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    throw new Error('Invalid Ethereum address');
  }

  const contracts = resolveEthTokenContracts();
  const code = params.assetCode.toUpperCase();
  const tokenAddress = code === 'EURC' ? contracts.eurc : contracts.usdc;
  if (!tokenAddress) throw new Error(`Unsupported EVM asset: ${code}`);

  const secret = decryptWalletSecret(row.ethereum_secret_encrypted);
  const provider = new ethers.JsonRpcProvider(resolveEthRpc());
  const wallet = new ethers.Wallet(secret, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const decimals = await token.decimals();
  const amountWei = ethers.parseUnits(params.amount, decimals);

  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance === BigInt(0)) {
    throw new Error(
      'Insufficient ETH for gas. Fund your Ethereum wallet with a small amount of Sepolia ETH (testnet) first.'
    );
  }

  const tx = await token.transfer(to, amountWei);
  const receipt = await tx.wait();
  if (!receipt?.hash) throw new Error('EVM transfer failed');

  return { hash: receipt.hash, from: wallet.address, to };
}

export async function getCryptoBalances(userId: string): Promise<{
  stellar: Record<string, string>;
  ethereum: Record<string, string>;
}> {
  const row = await loadCryptoRow(userId);
  const stellar: Record<string, string> = { USDC: '0', EURC: '0', XLM: '0' };
  const ethereum: Record<string, string> = { USDC: '0', EURC: '0', ETH: '0' };

  if (!row?.stellar_deposit_address) {
    return { stellar, ethereum };
  }

  try {
    const server = new StellarSdk.Horizon.Server(horizonUrl());
    const account = await server.loadAccount(row.stellar_deposit_address);
    for (const b of account.balances as {
      asset_type?: string;
      asset_code?: string;
      balance?: string;
    }[]) {
      if (b.asset_type === 'native') stellar.XLM = b.balance ?? '0';
      else if (b.asset_code === 'USDC') stellar.USDC = b.balance ?? '0';
      else if (b.asset_code === 'EURC') stellar.EURC = b.balance ?? '0';
    }
  } catch {
    /* account not funded yet */
  }

  if (row.ethereum_deposit_address) {
    try {
      const provider = new ethers.JsonRpcProvider(resolveEthRpc());
      const ethBal = await provider.getBalance(row.ethereum_deposit_address);
      ethereum.ETH = ethers.formatEther(ethBal);
      const contracts = resolveEthTokenContracts();
      const erc20 = [
        ['USDC', contracts.usdc],
        ['EURC', contracts.eurc],
      ] as const;
      for (const [code, tokenAddress] of erc20) {
        const token = new ethers.Contract(
          tokenAddress,
          [
            'function balanceOf(address) view returns (uint256)',
            'function decimals() view returns (uint8)',
          ],
          provider
        );
        const bal = await token.balanceOf(row.ethereum_deposit_address);
        const dec = await token.decimals();
        ethereum[code] = ethers.formatUnits(bal, dec);
      }
    } catch {
      /* rpc or contract read failed */
    }
  }

  return { stellar, ethereum };
}

export async function routeCryptoSend(params: {
  userId: string;
  network: string;
  asset: string;
  to: string;
  amount: string;
  memo?: string;
}): Promise<{ hash: string; network: string; asset: string; from: string; to: string }> {
  const network = params.network.toLowerCase();
  const asset = params.asset.toUpperCase();

  if (!['USDC', 'EURC'].includes(asset)) {
    throw new Error('Only USDC and EURC are supported');
  }

  if (network === 'stellar') {
    const r = await sendStellarAsset({
      userId: params.userId,
      toAddress: params.to,
      amount: params.amount,
      assetCode: asset,
      memo: params.memo,
    });
    return { ...r, network: 'stellar', asset };
  }

  if (network === 'ethereum' || network === 'eth') {
    const r = await sendEthereumToken({
      userId: params.userId,
      toAddress: params.to,
      amount: params.amount,
      assetCode: asset,
    });
    return { ...r, network: 'ethereum', asset };
  }

  throw new Error(`Unsupported network: ${params.network}`);
}
