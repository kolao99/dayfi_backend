/* Replace with your SQL commands */
ALTER TABLE wallet_transactions
    ADD COLUMN collection_sequence_id VARCHAR(255),
ADD COLUMN payment_sequence_id VARCHAR(255);

