/* Replace with your SQL commands */
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'card_to_wallet';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'bank_to_wallet';
