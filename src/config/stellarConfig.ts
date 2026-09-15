/**
 * Stellar network + Horizon (aligned with dayfi.wallet/backend/src/config/stellarConfig.js).
 */
import StellarSdk from '@stellar/stellar-sdk';
import { isProductionRuntime } from './productionNetworkGuard';

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const MAINNET_PASSPHRASE = StellarSdk.Networks.PUBLIC;

let horizonMismatchWarned = false;

export type StellarConfig = {
  network: string;
  isTestnet: boolean;
  horizonUrl: string;
  networkPassphrase: string;
  friendbotUrl: string | null;
};

export function getStellarConfig(): StellarConfig {
  const raw = (process.env.STELLAR_NETWORK || '').trim().toLowerCase();
  // Non-production may omit STELLAR_NETWORK → testnet for safety.
  // Production must set mainnet explicitly (enforced by productionNetworkGuard).
  const network = raw || (isProductionRuntime() ? '' : 'testnet');
  const isTestnet = network !== 'mainnet';

  let horizonUrl = process.env.STELLAR_HORIZON_URL?.trim();

  if (!horizonUrl) {
    horizonUrl = isTestnet ? TESTNET_HORIZON : MAINNET_HORIZON;
  } else {
    const urlIsTestnet =
      horizonUrl.includes('testnet') ||
      horizonUrl.includes('futurenet') ||
      horizonUrl.includes('localhost') ||
      horizonUrl.includes('127.0.0.1');

    if (isTestnet && !urlIsTestnet) {
      if (isProductionRuntime()) {
        throw new Error(
          '[FATAL] STELLAR_HORIZON_URL/STELLAR_NETWORK mismatch in production'
        );
      }
      if (!horizonMismatchWarned) {
        console.warn(
          'STELLAR_HORIZON_URL points at mainnet but STELLAR_NETWORK is testnet — using testnet Horizon'
        );
        horizonMismatchWarned = true;
      }
      horizonUrl = TESTNET_HORIZON;
    } else if (!isTestnet && urlIsTestnet) {
      if (isProductionRuntime()) {
        throw new Error(
          `[FATAL] Production STELLAR_HORIZON_URL must be mainnet (got ${horizonUrl})`
        );
      }
      if (!horizonMismatchWarned) {
        console.warn(
          'STELLAR_HORIZON_URL is testnet but STELLAR_NETWORK is mainnet — using mainnet Horizon'
        );
        horizonMismatchWarned = true;
      }
      horizonUrl = MAINNET_HORIZON;
    }
  }

  return {
    network: network || (isTestnet ? 'testnet' : 'mainnet'),
    isTestnet,
    horizonUrl,
    networkPassphrase: isTestnet
      ? StellarSdk.Networks.TESTNET
      : MAINNET_PASSPHRASE,
    friendbotUrl: isTestnet ? 'https://friendbot.stellar.org' : null,
  };
}
