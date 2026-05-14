/* Replace with your SQL commands */
CREATE TABLE exchange_rates (
        id SERIAL PRIMARY KEY,
        base_currency VARCHAR(10) NOT NULL,
        target_currency VARCHAR(10) NOT NULL,
        rate NUMERIC(15, 6) NOT NULL,
        source VARCHAR(50) DEFAULT 'manual',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT unique_pair UNIQUE (base_currency, target_currency)
);

CREATE TABLE wallet_currency_swaps (
       swap_id VARCHAR PRIMARY KEY DEFAULT 'swap-' || LOWER(REPLACE(CAST(uuid_generate_v1mc() AS varchar(20)), '-', '')),
       user_id VARCHAR NOT NULL REFERENCES users(user_id),
       from_wallet_id VARCHAR NOT NULL REFERENCES wallets(wallet_id),
       to_wallet_id VARCHAR NOT NULL REFERENCES wallets(wallet_id),
       from_currency VARCHAR(10) NOT NULL,
       to_currency VARCHAR(10) NOT NULL,
       amount NUMERIC(15,2) NOT NULL,
       exchange_rate NUMERIC(15,6) NOT NULL,
       converted_amount NUMERIC(15,2) NOT NULL,
       status VARCHAR(20) DEFAULT 'completed',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

