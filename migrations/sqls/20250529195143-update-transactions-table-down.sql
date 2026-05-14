/* Replace with your SQL commands */
ALTER TABLE wallet_transactions
DROP COLUMN card_last4,
DROP COLUMN card_type,
DROP COLUMN card_brand,
DROP COLUMN card_country,
DROP COLUMN card_token,
DROP COLUMN card_transaction_ref;