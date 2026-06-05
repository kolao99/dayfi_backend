/**
 * Stellar network + Horizon (aligned with dayfi.wallet/backend/src/config/stellarConfig.js).
 */
import StellarSdk from '@stellar/stellar-sdk';

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const MAINNET_HORIZON = 'https://horizon.stellar.org';

let horizonMismatchWarned = false;

export type StellarConfig = {
  network: string;
  isTestnet: boolean;
  horizonUrl: string;
  networkPassphrase: string;
  friendbotUrl: string | null;
};

export function getStellarConfig(): StellarConfig {
  const network = (process.env.STELLAR_NETWORK || 'testnet').trim().toLowerCase();
  const isTestnet = network !== 'mainnet';

  let horizonUrl = process.env.STELLAR_HORIZON_URL?.trim();

  if (!horizonUrl) {
    horizonUrl = isTestnet ? TESTNET_HORIZON : MAINNET_HORIZON;
  } else {
    const urlIsTestnet =
      horizonUrl.includes('testnet') || horizonUrl.includes('futurenet');

    if (isTestnet && !urlIsTestnet) {
      if (!horizonMismatchWarned) {
        console.warn(
          'STELLAR_HORIZON_URL points at mainnet but STELLAR_NETWORK is testnet — using testnet Horizon'
        );
        horizonMismatchWarned = true;
      }
      horizonUrl = TESTNET_HORIZON;
    } else if (!isTestnet && urlIsTestnet) {
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
    network,
    isTestnet,
    horizonUrl,
    networkPassphrase: isTestnet
      ? StellarSdk.Networks.TESTNET
      : StellarSdk.Networks.PUBLIC,
    friendbotUrl: isTestnet ? 'https://friendbot.stellar.org' : null,
  };
}
