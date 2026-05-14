/* Replace with your SQL commands */

ALTER TABLE wallet_transactions
    ADD COLUMN user_id VARCHAR NOT NULL,
    ADD COLUMN sender_wallet_id VARCHAR,
    ADD COLUMN recipient_wallet_id VARCHAR,
    ADD COLUMN external_account_number VARCHAR(20),
    ADD COLUMN external_bank_code VARCHAR(10),
    ADD COLUMN external_bank_name VARCHAR(255),
    ADD COLUMN amount NUMERIC(15, 2),
    ADD COLUMN balance NUMERIC(15, 2) DEFAULT 0.00,
    ADD COLUMN fees NUMERIC(15, 2) DEFAULT 0.00,
    ADD COLUMN type transaction_type,
    ADD COLUMN reference VARCHAR(255) UNIQUE,
    ADD COLUMN narration TEXT,
    ADD COLUMN metadata JSONB,
    ADD COLUMN initiated_by VARCHAR,
    ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN card_country VARCHAR(255);

ALTER TABLE wallet_transactions
DROP COLUMN beneficiary_id,
    DROP COLUMN source_id,
    DROP COLUMN send_channel,
    DROP COLUMN send_network,
    DROP COLUMN send_amount,
    DROP COLUMN receive_channel,
    DROP COLUMN receive_network,
    DROP COLUMN receive_amount,
    DROP COLUMN reason;

ALTER TABLE wallet_transactions RENAME COLUMN timestamp TO created_at;

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_pkey;
ALTER TABLE wallet_transactions RENAME COLUMN id TO wallet_transactions_id;
ALTER TABLE wallet_transactions ADD COLUMN id UUID PRIMARY KEY DEFAULT gen_random_uuid();

DROP TYPE channel;
DROP TYPE network;

DROP TABLE source;

ALTER TABLE beneficiaries ADD COLUMN old_id SERIAL PRIMARY KEY;

ALTER TABLE beneficiaries DROP COLUMN id;

ALTER TABLE beneficiaries RENAME COLUMN old_id TO id;

ALTER TABLE beneficiaries
    ADD COLUMN user_id VARCHAR(100) NOT NULL,
    ADD COLUMN type VARCHAR(20) NOT NULL CHECK (type IN ('fiat', 'crypto')),
    ADD COLUMN currency VARCHAR(10) NOT NULL,
    ADD COLUMN account_number VARCHAR(30),
    ADD COLUMN bank_name VARCHAR(100),
    ADD COLUMN bank_code VARCHAR(20),
    ADD COLUMN wallet_address VARCHAR(255),
    ADD COLUMN network VARCHAR(50),
    ADD COLUMN asset VARCHAR(20);

ALTER TABLE beneficiaries RENAME COLUMN name TO account_name;

ALTER TABLE beneficiaries DROP COLUMN email;

ALTER TABLE beneficiaries
ALTER COLUMN country TYPE VARCHAR(10),
    ALTER COLUMN dob TYPE DATE USING dob::DATE,
    ALTER COLUMN id_number TYPE VARCHAR(50),
    ALTER COLUMN id_type TYPE VARCHAR(20),
    ALTER COLUMN phone TYPE VARCHAR(20);
