ALTER TABLE wallets
  ADD COLUMN stellar_deposit_address VARCHAR(255),
  ADD COLUMN stellar_secret_encrypted TEXT,
  ADD COLUMN ethereum_deposit_address VARCHAR(255),
  ADD COLUMN ethereum_secret_encrypted TEXT,
  ADD COLUMN crypto_mnemonic_encrypted TEXT;
