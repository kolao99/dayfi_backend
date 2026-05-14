/* Replace with your SQL commands */
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE beneficiaries ADD COLUMN new_id VARCHAR(255) UNIQUE;
UPDATE beneficiaries SET new_id = 'ben-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', ''));

ALTER TABLE beneficiaries DROP CONSTRAINT beneficiaries_pkey;

ALTER TABLE beneficiaries DROP COLUMN id;
ALTER TABLE beneficiaries RENAME COLUMN new_id TO id;
ALTER TABLE beneficiaries ADD PRIMARY KEY (id);

ALTER TABLE beneficiaries
    DROP COLUMN type,
    DROP COLUMN currency,
    DROP COLUMN account_number,
    DROP COLUMN bank_name,
    DROP COLUMN bank_code,
    DROP COLUMN wallet_address,
    DROP COLUMN network,
    DROP COLUMN asset;

ALTER TABLE beneficiaries RENAME COLUMN account_name TO name;

ALTER TABLE beneficiaries ADD COLUMN email VARCHAR(255);

ALTER TABLE beneficiaries
ALTER COLUMN country TYPE VARCHAR(255),
    ALTER COLUMN dob TYPE VARCHAR(255),
    ALTER COLUMN id_number TYPE VARCHAR(255),
    ALTER COLUMN id_type TYPE VARCHAR(255),
    ALTER COLUMN phone TYPE VARCHAR(255);

CREATE TABLE source (
                        id VARCHAR(255) PRIMARY KEY DEFAULT 'src-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', '')),
                        account_type VARCHAR(255),
                        account_number VARCHAR(255),
                        network_id VARCHAR(255),
                        beneficiary_id VARCHAR(255) REFERENCES beneficiaries(id)
);

CREATE TYPE channel AS ENUM ('bank', 'wallet', 'crypto');
CREATE TYPE network AS ENUM ('ethereum', 'bitcoin', 'polygon', 'stellar');

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_pkey;
ALTER TABLE wallet_transactions DROP COLUMN IF EXISTS id;
ALTER TABLE wallet_transactions RENAME COLUMN wallet_transactions_id TO id;
ALTER TABLE wallet_transactions ADD PRIMARY KEY (id);


ALTER TABLE wallet_transactions
    ADD COLUMN beneficiary_id VARCHAR(255) REFERENCES beneficiaries(id),
    ADD COLUMN source_id VARCHAR(255) REFERENCES source(id),
    ADD COLUMN send_channel channel,
    ADD COLUMN send_network network,
    ADD COLUMN send_amount NUMERIC(15, 2),
    ADD COLUMN receive_channel channel,
    ADD COLUMN receive_network network,
    ADD COLUMN receive_amount NUMERIC(15, 2),
    ADD COLUMN reason TEXT;

ALTER TABLE wallet_transactions RENAME COLUMN created_at TO timestamp;

ALTER TABLE wallet_transactions
    DROP COLUMN sender_wallet_id,
    DROP COLUMN recipient_wallet_id,
    DROP COLUMN external_account_number,
    DROP COLUMN external_bank_code,
    DROP COLUMN external_bank_name,
    DROP COLUMN amount,
    DROP COLUMN balance,
    DROP COLUMN fees,
    DROP COLUMN type,
    DROP COLUMN reference,
    DROP COLUMN narration,
    DROP COLUMN metadata,
    DROP COLUMN initiated_by,
    DROP COLUMN updated_at,
    DROP COLUMN IF EXISTS card_country;
