/**
 * Crypto engine facade — single entry for Azap multi-asset wallet/trade readiness.
 */

import {
  listCatalogAssets,
  resolveEffectiveCapabilities,
  type EffectiveAssetCapability,
} from '../azap/crypto/assetRegistry';
import { ensureWallet, publicWalletView } from './ensureWallet';
import {
  probeYellowCardCryptoCapabilities,
  type YcCryptoCapabilitySnapshot,
} from './yellowCardCapabilityService';
import {
  prepareCryptoTrade,
  type CryptoTradeQuoteRequest,
  type CryptoTradeGateResult,
} from './cryptoTradeGate';

export {
  ensureWallet,
  publicWalletView,
  prepareCryptoTrade,
  probeYellowCardCryptoCapabilities,
  listCatalogAssets,
  resolveEffectiveCapabilities,
};

export type { EffectiveAssetCapability, YcCryptoCapabilitySnapshot };
export type { CryptoTradeQuoteRequest, CryptoTradeGateResult };

export async function getCryptoEngineStatus(): Promise<{
  catalog: ReturnType<typeof listCatalogAssets>;
  yc: YcCryptoCapabilitySnapshot;
  matrix: EffectiveAssetCapability[];
}> {
  const yc = await probeYellowCardCryptoCapabilities();
  return {
    catalog: listCatalogAssets(),
    yc,
    matrix: yc.effectiveAssets,
  };
}
