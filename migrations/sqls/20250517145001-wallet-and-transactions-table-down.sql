/* Replace with your SQL commands */
ALTER TABLE users
    DROP COLUMN level;

DROP TABLE IF EXISTS wallet_transactions;

DROP TABLE IF EXISTS wallets;

DROP TYPE IF EXISTS transaction_type;
DROP TYPE IF EXISTS transaction_status;
