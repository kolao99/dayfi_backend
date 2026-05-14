CREATE TYPE transaction_type AS ENUM ('wallet_to_wallet', 'wallet_to_bank');
CREATE TYPE transaction_status AS ENUM ('pending', 'success', 'failed');

CREATE TABLE wallets (
             wallet_id VARCHAR PRIMARY KEY DEFAULT 'wallet-' || LOWER(REPLACE(CAST(uuid_generate_v1mc() AS varchar(20)), '-', '')),
             user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
             wallet_reference VARCHAR(255) UNIQUE NOT NULL,
             account_name VARCHAR(255),
             dayfi_id VARCHAR(255),
             account_number VARCHAR(20),
             bank_code VARCHAR(10),
             bank_name VARCHAR(255),
             balance NUMERIC(15, 2) DEFAULT 0.00,
             currency VARCHAR(10) DEFAULT 'NGN',
             provider VARCHAR(50) DEFAULT 'paystack',
             created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
             updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wallet_transactions (
             id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
             wallet_transactions_id VARCHAR UNIQUE DEFAULT 'wallet-transactions-' || LOWER(REPLACE(CAST(uuid_generate_v1mc() AS varchar(20)), '-', '')),
             user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
             sender_wallet_id VARCHAR NOT NULL REFERENCES wallets(wallet_id),
             recipient_wallet_id VARCHAR REFERENCES wallets(wallet_id),
             external_account_number VARCHAR(20),
             external_bank_code VARCHAR(10),
             external_bank_name VARCHAR(255),
             amount NUMERIC(15, 2) NOT NULL,
             balance NUMERIC(15, 2) DEFAULT 0.00,
             fees NUMERIC(15, 2) DEFAULT 0.00,
             type transaction_type NOT NULL,
             status transaction_status DEFAULT 'pending',
             reference VARCHAR(255) UNIQUE NOT NULL,
             narration TEXT,
             metadata JSONB,
             initiated_by VARCHAR NOT NULL REFERENCES users(user_id),
             created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
             updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users
    ADD COLUMN level VARCHAR(255) NOT NULL DEFAULT 'level-0';

