/**
 * First-class crypto wallet rows: user + asset + network.
 * Stellar USDC/EURC share one blockchain account; rows track per-asset readiness.
 */

import { db } from '../../config/database';

export type CryptoWalletStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'FAILED'
  | 'SUSPENDED';

export type CryptoAssetWalletRow = {
  id: string;
  user_id: string;
  asset: string;
  network: string;
  address: string;
  status: CryptoWalletStatus;
  provider: string;
  custody: string;
  trustline_ready: boolean;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export async function getCryptoAssetWallet(
  userId: string,
  asset: string,
  network: string
): Promise<CryptoAssetWalletRow | null> {
  return db.oneOrNone<CryptoAssetWalletRow>(
    `SELECT *
     FROM crypto_asset_wallets
     WHERE user_id = $1
       AND upper(asset) = upper($2)
       AND lower(network) = lower($3)
     LIMIT 1`,
    [userId, asset, network]
  );
}

export async function upsertCryptoAssetWallet(input: {
  userId: string;
  asset: string;
  network: string;
  address: string;
  status: CryptoWalletStatus;
  provider?: string;
  custody?: string;
  trustlineReady?: boolean;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<CryptoAssetWalletRow> {
  return db.one<CryptoAssetWalletRow>(
    `INSERT INTO crypto_asset_wallets (
       user_id, asset, network, address, status, provider, custody,
       trustline_ready, last_error, metadata
     ) VALUES (
       $1, upper($2), lower($3), $4, $5, $6, $7, $8, $9, $10::jsonb
     )
     ON CONFLICT (user_id, asset, network) DO UPDATE SET
       address = EXCLUDED.address,
       status = EXCLUDED.status,
       provider = EXCLUDED.provider,
       custody = EXCLUDED.custody,
       trustline_ready = EXCLUDED.trustline_ready,
       last_error = EXCLUDED.last_error,
       metadata = COALESCE(crypto_asset_wallets.metadata, '{}'::jsonb)
                 || EXCLUDED.metadata,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      input.userId,
      input.asset,
      input.network,
      input.address,
      input.status,
      input.provider || 'dayfi',
      input.custody || 'dayfi_ledger',
      Boolean(input.trustlineReady),
      input.lastError ?? null,
      JSON.stringify(input.metadata || {}),
    ]
  );
}
