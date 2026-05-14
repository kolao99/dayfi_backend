/* Replace with your SQL commands */
ALTER TABLE wallet_transactions
ALTER COLUMN send_channel TYPE VARCHAR(255) USING send_channel::text,
  ALTER COLUMN send_network TYPE VARCHAR(255) USING send_network::text,
  ALTER COLUMN receive_channel TYPE VARCHAR(255) USING receive_channel::text,
  ALTER COLUMN receive_network TYPE VARCHAR(255) USING receive_network::text;

DROP TYPE IF EXISTS channel;
DROP TYPE IF EXISTS network;
