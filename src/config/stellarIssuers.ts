/**
 * Stellar asset issuers (testnet vs mainnet). Prevents mainnet issuer on testnet.
 * @see https://developers.circle.com/stablecoins/docs
 */
import StellarSdk from '@stellar/stellar-sdk';

export const MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const TESTNET_USDC_ISSUER =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export const MAINNET_EURC_ISSUER =
  'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
export const TESTNET_EURC_ISSUER =
  'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO';

function isValidIssuerKey(key: string | undefined): key is string {
  return typeof key === 'string' && /^G[A-Z2-7]{55}$/.test(key);
}

export function isStellarTestnet(): boolean {
  return (process.env.STELLAR_NETWORK || 'testnet').toLowerCase() !== 'mainnet';
}

export function resolveUsdcIssuer(isTestnet = isStellarTestnet()): string {
  const fromEnv =
    process.env.STELLAR_USDC_ISSUER?.trim() ||
    process.env.USDC_ISSUER?.trim();
  const fallback = isTestnet ? TESTNET_USDC_ISSUER : MAINNET_USDC_ISSUER;
  if (!fromEnv || !isValidIssuerKey(fromEnv)) return fallback;
  if (isTestnet && fromEnv === MAINNET_USDC_ISSUER) return TESTNET_USDC_ISSUER;
  if (!isTestnet && fromEnv === TESTNET_USDC_ISSUER) return MAINNET_USDC_ISSUER;
  return fromEnv;
}

export function resolveEurcIssuer(isTestnet = isStellarTestnet()): string {
  const fromEnv = process.env.STELLAR_EURC_ISSUER?.trim() || process.env.EURC_ISSUER?.trim();
  const fallback = isTestnet ? TESTNET_EURC_ISSUER : MAINNET_EURC_ISSUER;
  if (!fromEnv || !isValidIssuerKey(fromEnv)) return fallback;
  return fromEnv;
}

/** Stellar trustline assets to open for receive (USDC + EURC). */
export function buildReceiveTrustlineAssets() {
  return [
    new StellarSdk.Asset('USDC', resolveUsdcIssuer()),
    new StellarSdk.Asset('EURC', resolveEurcIssuer()),
  ];
}

/** Ethereum ERC-20 addresses for receive UI (Sepolia when testnet). */
export function resolveEthTokenContracts(): {
  network: 'sepolia' | 'mainnet';
  usdc: string;
  eurc: string;
} {
  const testnet =
    (process.env.ETH_NETWORK || '').toLowerCase() === 'sepolia' ||
    ((process.env.ETH_NETWORK || '').toLowerCase() !== 'mainnet' &&
      isStellarTestnet());

  if (testnet) {
    return {
      network: 'sepolia',
      usdc:
        process.env.ETH_SEPOLIA_USDC_ADDRESS?.trim() ||
        '0x1c7D4B196Cb0C7B01f48AbaE9d411a3C0f2c31E9',
      eurc:
        process.env.ETH_SEPOLIA_EURC_ADDRESS?.trim() ||
        '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
    };
  }
  return {
    network: 'mainnet',
    usdc:
      process.env.ETH_MAINNET_USDC_ADDRESS?.trim() ||
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    eurc:
      process.env.ETH_MAINNET_EURC_ADDRESS?.trim() ||
      '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
  };
}
