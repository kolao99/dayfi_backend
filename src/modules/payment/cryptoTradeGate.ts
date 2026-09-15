/**
 * Crypto trade gate — multi-asset engine entry for buy/sell proposals.
 * LLM proposes; this layer validates catalog + wallet + live YC entitlement.
 */

import {
  findAssetNetwork,
  normalizeNetworkKey,
} from '../azap/crypto/assetRegistry';
import { probeYellowCardCryptoCapabilities } from './yellowCardCapabilityService';
import { ensureWallet, publicWalletView } from './ensureWallet';

export type CryptoTradeQuoteRequest = {
  userId: string;
  side: 'buy' | 'sell';
  asset: string;
  network?: string;
  fiatAmount?: number | null;
  cryptoAmount?: number | null;
};

export type CryptoTradeGateResult =
  | {
      ok: false;
      code: string;
      message: string;
      wallet?: ReturnType<typeof publicWalletView>;
    }
  | {
      ok: true;
      ready: false;
      code: 'YC_NOT_ENTITLED' | 'WALLET_PENDING' | 'E2E_NOT_READY';
      message: string;
      blockers: string[];
      wallet?: ReturnType<typeof publicWalletView>;
      catalogAsset?: string;
      catalogNetwork?: string;
    }
  | {
      ok: true;
      ready: true;
      message: string;
      wallet: ReturnType<typeof publicWalletView>;
      catalogAsset: string;
      catalogNetwork: string;
    };

/**
 * Prepare a buy/sell: resolve catalog row, ensure wallet when strategy exists,
 * then refuse execution until live YC + E2E readiness is true.
 */
export async function prepareCryptoTrade(
  input: CryptoTradeQuoteRequest
): Promise<CryptoTradeGateResult> {
  const asset = String(input.asset || '')
    .trim()
    .toUpperCase();
  const network = normalizeNetworkKey(input.network || defaultNetworkFor(asset));

  const cfg = findAssetNetwork(asset, network);
  if (!cfg) {
    return {
      ok: false,
      code: 'UNKNOWN_ASSET_NETWORK',
      message: `${asset} on ${network} is not in the crypto engine catalog yet.`,
    };
  }

  const ensured = await ensureWallet({
    userId: input.userId,
    asset,
    network,
  });

  if (!ensured.ok) {
    if (ensured.code === 'WALLET_STRATEGY_PENDING') {
      return {
        ok: true,
        ready: false,
        code: 'WALLET_PENDING',
        message: ensured.message,
        blockers: [ensured.code],
        wallet: ensured.wallet
          ? publicWalletView(ensured.wallet)
          : undefined,
        catalogAsset: asset,
        catalogNetwork: network,
      };
    }
    return {
      ok: false,
      code: ensured.code || 'WALLET_NOT_READY',
      message:
        ensured.message ||
        `I couldn't ready your ${asset} wallet on ${network} yet.`,
      wallet: ensured.wallet
        ? publicWalletView(ensured.wallet)
        : undefined,
    };
  }

  const caps = await probeYellowCardCryptoCapabilities();
  const effective = caps.effectiveAssets.find(
    (a) =>
      a.symbol === asset && normalizeNetworkKey(a.network) === network
  );

  const entitled =
    input.side === 'buy'
      ? Boolean(effective?.userExposedBuy)
      : Boolean(effective?.userExposedSell);

  if (!entitled) {
    const blockers = [
      ...(effective?.blockers || []),
      ...caps.blockers.slice(0, 3),
    ];
    return {
      ok: true,
      ready: false,
      code: 'YC_NOT_ENTITLED',
      message:
        input.side === 'buy'
          ? `${asset} on ${network}: wallet path is wired in the crypto engine, but Yellow Card buy isn't enabled for our live account on this pair yet. I won't pretend it works.`
          : `${asset} on ${network}: wallet path is wired, but Yellow Card sell isn't enabled for our live account on this pair yet.`,
      blockers,
      wallet: publicWalletView(ensured.wallet),
      catalogAsset: asset,
      catalogNetwork: network,
    };
  }

  // Safety: even if flags flip, do not execute until full settlement executor ships.
  return {
    ok: true,
    ready: false,
    code: 'E2E_NOT_READY',
    message: `${asset}/${network} looks entitled, but the full quote→confirm→PIN→YC→webhook→ledger executor is not production-complete yet.`,
    blockers: ['settlement_executor_incomplete'],
    wallet: publicWalletView(ensured.wallet),
    catalogAsset: asset,
    catalogNetwork: network,
  };
}

function defaultNetworkFor(asset: string): string {
  if (asset === 'BTC') return 'bitcoin';
  if (asset === 'ETH') return 'ethereum';
  if (asset === 'SOL') return 'solana';
  return 'stellar';
}
