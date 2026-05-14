/* Replace with your SQL commands */
ALTER TABLE wallet_transactions
    ADD COLUMN card_last4 VARCHAR(4),
    ADD COLUMN card_type VARCHAR(50),
    ADD COLUMN card_brand VARCHAR(50),
    ADD COLUMN card_country VARCHAR(5),
    ADD COLUMN card_token VARCHAR(255),
    ADD COLUMN card_transaction_ref VARCHAR(255);
