ALTER TYPE transaction_status RENAME TO transaction_status_old;

CREATE TYPE transaction_status AS ENUM (
  'pending-collection',
  'success-collection',
  'failed-collection',
  'pending-payment',
  'success-payment',
  'failed-payment'
);

ALTER TABLE wallet_transactions ADD COLUMN status_tmp text;

UPDATE wallet_transactions
SET status_tmp = CASE status::text
    WHEN 'pending' THEN 'pending-collection'
  WHEN 'success' THEN 'success-collection'
  WHEN 'failed'  THEN 'failed-collection'
END;

ALTER TABLE wallet_transactions DROP COLUMN status;

ALTER TABLE wallet_transactions ADD COLUMN status transaction_status;

UPDATE wallet_transactions
SET status = status_tmp::transaction_status;

ALTER TABLE wallet_transactions DROP COLUMN status_tmp;

DROP TYPE transaction_status_old;
