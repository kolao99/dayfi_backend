/**
 * Wallet activation strategies for the crypto engine.
 * Stellar/EVM are live Dayfi custody; BTC/Solana strategies are stubs until infra exists.
 */

import StellarSdk from '@stellar/stellar-sdk';
import {
  findAssetNetwork,
  normalizeNetworkKey,
  type WalletActivationStrategyId,
} from '../azap/crypto/assetRegistry';
import { buildReceiveTrustlineAssets } from '../../config/stellarIssuers';
import { getStellarConfig } from '../../config/stellarConfig';
import {
  CryptoProvisionError,
  getPersistedCryptoDepositAddresses,
  isUserCryptoWalletReady,
  provisionCryptoWalletsForUser,
} from './cryptoWalletProvision';
import {
  getCryptoAssetWallet,
  upsertCryptoAssetWallet,
  type CryptoAssetWalletRow,
} from './cryptoAssetWalletStore';

export type EnsureWalletInput = {
  userId: string;
  asset: string;
  network: string;
};

export type EnsureWalletResult =
  | { ok: true; wallet: CryptoAssetWalletRow }
  | { ok: false; code: string; message: string; wallet?: CryptoAssetWalletRow };

type ActivationStrategy = {
  id: WalletActivationStrategyId;
  activate: (input: {
    userId: string;
    asset: string;
    network: string;
  }) => Promise<EnsureWalletResult>;
};

function horizonUrl(): string {
  return getStellarConfig().horizonUrl;
}

async function stellarTrustlineReady(
  address: string,
  asset: string
): Promise<boolean> {
  const wanted = buildReceiveTrustlineAssets().find(
    (a) => a.getCode().toUpperCase() === asset.toUpperCase()
  );
  if (!wanted) return false;
  try {
    const server = new StellarSdk.Horizon.Server(horizonUrl());
    const account = await server.loadAccount(address);
    return (
      account.balances as { asset_code?: string; asset_issuer?: string }[]
    ).some(
      (b) =>
        b.asset_code === wanted.getCode() &&
        b.asset_issuer === wanted.getIssuer()
    );
  } catch {
    return false;
  }
}

const stellarDayfiStrategy: ActivationStrategy = {
  id: 'stellar_dayfi',
  async activate({ userId, asset, network }) {
    const existing = await getCryptoAssetWallet(userId, asset, network);
    if (
      existing?.status === 'ACTIVE' &&
      existing.trustline_ready &&
      existing.address
    ) {
      const stillReady = await stellarTrustlineReady(existing.address, asset);
      if (stillReady) return { ok: true, wallet: existing };
    }
    if (existing?.status === 'SUSPENDED') {
      return {
        ok: false,
        code: 'WALLET_SUSPENDED',
        message: 'This wallet is suspended. Contact support.',
        wallet: existing,
      };
    }

    await upsertCryptoAssetWallet({
      userId,
      asset,
      network,
      address: existing?.address || 'pending',
      status: 'PENDING',
      trustlineReady: false,
      lastError: null,
      metadata: { phase: 'activating', strategy: 'stellar_dayfi' },
    });

    try {
      let addresses = await getPersistedCryptoDepositAddresses(userId);
      if (!addresses.stellar || !(await isUserCryptoWalletReady(userId))) {
        await provisionCryptoWalletsForUser(userId);
        addresses = await getPersistedCryptoDepositAddresses(userId);
      }
      const stellar = String(addresses.stellar || '').trim();
      if (!stellar) {
        const failed = await upsertCryptoAssetWallet({
          userId,
          asset,
          network,
          address: existing?.address || 'pending',
          status: 'FAILED',
          trustlineReady: false,
          lastError: 'Stellar address missing after provision',
        });
        return {
          ok: false,
          code: 'PROVISION_FAILED',
          message: 'Could not provision Stellar wallet',
          wallet: failed,
        };
      }

      let ready = await stellarTrustlineReady(stellar, asset);
      if (!ready) {
        await provisionCryptoWalletsForUser(userId);
        ready = await stellarTrustlineReady(stellar, asset);
      }

      const wallet = await upsertCryptoAssetWallet({
        userId,
        asset,
        network,
        address: stellar,
        status: ready ? 'ACTIVE' : 'FAILED',
        trustlineReady: ready,
        lastError: ready
          ? null
          : `${asset} trustline not active on Stellar account`,
        metadata: { sharedStellarAccount: true, strategy: 'stellar_dayfi' },
      });

      if (!ready) {
        return {
          ok: false,
          code: 'TRUSTLINE_PENDING',
          message: `${asset} trustline is not ready yet. Try again shortly.`,
          wallet,
        };
      }
      return { ok: true, wallet };
    } catch (err) {
      const msg =
        err instanceof CryptoProvisionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      const failed = await upsertCryptoAssetWallet({
        userId,
        asset,
        network,
        address: existing?.address || 'pending',
        status: 'FAILED',
        trustlineReady: false,
        lastError: msg.slice(0, 500),
      });
      return {
        ok: false,
        code: 'PROVISION_FAILED',
        message: msg.slice(0, 300),
        wallet: failed,
      };
    }
  },
};

const evmDayfiStrategy: ActivationStrategy = {
  id: 'evm_dayfi',
  async activate({ userId, asset, network }) {
    const existing = await getCryptoAssetWallet(userId, asset, network);
    if (existing?.status === 'ACTIVE' && existing.address?.startsWith('0x')) {
      return { ok: true, wallet: existing };
    }
    if (existing?.status === 'SUSPENDED') {
      return {
        ok: false,
        code: 'WALLET_SUSPENDED',
        message: 'This wallet is suspended. Contact support.',
        wallet: existing,
      };
    }

    await upsertCryptoAssetWallet({
      userId,
      asset,
      network,
      address: existing?.address || 'pending',
      status: 'PENDING',
      trustlineReady: false,
      metadata: { strategy: 'evm_dayfi' },
    });

    try {
      let addresses = await getPersistedCryptoDepositAddresses(userId);
      if (!addresses.evm) {
        await provisionCryptoWalletsForUser(userId);
        addresses = await getPersistedCryptoDepositAddresses(userId);
      }
      const evm = String(addresses.evm || '').trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(evm)) {
        const failed = await upsertCryptoAssetWallet({
          userId,
          asset,
          network,
          address: existing?.address || 'pending',
          status: 'FAILED',
          trustlineReady: false,
          lastError: 'EVM address missing after provision',
        });
        return {
          ok: false,
          code: 'PROVISION_FAILED',
          message: 'Could not provision EVM wallet',
          wallet: failed,
        };
      }

      // One EVM address shared across ETH / ERC-20 USDC rows.
      const wallet = await upsertCryptoAssetWallet({
        userId,
        asset,
        network,
        address: evm,
        status: 'ACTIVE',
        trustlineReady: true,
        lastError: null,
        metadata: { sharedEvmAccount: true, strategy: 'evm_dayfi' },
      });
      return { ok: true, wallet };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failed = await upsertCryptoAssetWallet({
        userId,
        asset,
        network,
        address: existing?.address || 'pending',
        status: 'FAILED',
        trustlineReady: false,
        lastError: msg.slice(0, 500),
      });
      return {
        ok: false,
        code: 'PROVISION_FAILED',
        message: msg.slice(0, 300),
        wallet: failed,
      };
    }
  },
};

function pendingStrategy(
  id: WalletActivationStrategyId,
  label: string
): ActivationStrategy {
  return {
    id,
    async activate({ userId, asset, network }) {
      const existing = await getCryptoAssetWallet(userId, asset, network);
      const wallet = await upsertCryptoAssetWallet({
        userId,
        asset,
        network,
        address: existing?.address || 'pending',
        status: 'FAILED',
        trustlineReady: false,
        lastError: `${label} wallet activation not implemented yet`,
        metadata: { strategy: id },
      });
      return {
        ok: false,
        code: 'WALLET_STRATEGY_PENDING',
        message: `${asset} on ${network} is in the crypto engine catalog, but ${label} wallet activation is not implemented yet. We'll enable it when custody + YC E2E are ready.`,
        wallet,
      };
    },
  };
}

const STRATEGIES: Record<WalletActivationStrategyId, ActivationStrategy> = {
  stellar_dayfi: stellarDayfiStrategy,
  evm_dayfi: evmDayfiStrategy,
  bitcoin_pending: pendingStrategy('bitcoin_pending', 'Bitcoin'),
  solana_pending: pendingStrategy('solana_pending', 'Solana'),
  yc_hosted_pending: pendingStrategy('yc_hosted_pending', 'YC-hosted'),
};

/**
 * Idempotent wallet activation for user + asset + network.
 * Never returns private keys.
 */
export async function ensureWallet(
  input: EnsureWalletInput
): Promise<EnsureWalletResult> {
  const userId = String(input.userId || '').trim();
  const asset = String(input.asset || '')
    .trim()
    .toUpperCase();
  const network = normalizeNetworkKey(input.network);

  if (!userId) {
    return { ok: false, code: 'INVALID_USER', message: 'Invalid user id' };
  }

  const cfg = findAssetNetwork(asset, network);
  if (!cfg) {
    return {
      ok: false,
      code: 'UNKNOWN_ASSET_NETWORK',
      message: `${asset} on ${network} is not in the crypto engine catalog yet`,
    };
  }

  const strategy = STRATEGIES[cfg.walletStrategy];
  if (!strategy) {
    return {
      ok: false,
      code: 'WALLET_STRATEGY_PENDING',
      message: `No wallet activation strategy for ${asset}/${network}`,
    };
  }

  return strategy.activate({ userId, asset, network });
}

export function publicWalletView(wallet: CryptoAssetWalletRow): {
  asset: string;
  network: string;
  address: string;
  status: string;
  trustlineReady: boolean;
} {
  return {
    asset: wallet.asset,
    network: wallet.network,
    address: wallet.address,
    status: wallet.status,
    trustlineReady: wallet.trustline_ready,
  };
}
