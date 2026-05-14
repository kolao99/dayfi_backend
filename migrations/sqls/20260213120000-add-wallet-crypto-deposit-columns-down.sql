ALTER TABLE wallets
  DROP COLUMN IF EXISTS stellar_deposit_address,
  DROP COLUMN IF EXISTS stellar_secret_encrypted,
  DROP COLUMN IF EXISTS ethereum_deposit_address,
  DROP COLUMN IF EXISTS ethereum_secret_encrypted,
  DROP COLUMN IF EXISTS crypto_mnemonic_encrypted;
