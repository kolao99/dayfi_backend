/* Replace with your SQL commands */
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION generate_user_id() RETURNS VARCHAR AS $$
DECLARE
    digits CHAR(6);
BEGIN
    digits := LPAD(CAST((RANDOM() * 1000000)::INT AS TEXT), 6, '0');
    RETURN 'DAYFI-' || digits;
END;
$$ LANGUAGE plpgsql;

CREATE TYPE account_status AS ENUM('inactive', 'active', 'deactivated', 'blacklisted', 'flagged');
CREATE TYPE user_type AS ENUM('admin', 'user');

CREATE TABLE users (
       user_id VARCHAR UNIQUE DEFAULT generate_user_id(),
       email VARCHAR(255) UNIQUE NOT NULL,
       password TEXT NOT NULL,
       user_type user_type DEFAULT 'user',
       first_name VARCHAR(100),
       last_name VARCHAR(100),
       middle_name VARCHAR(100),
       gender VARCHAR(100),
       date_of_birth DATE,
       country VARCHAR(100),
       state VARCHAR(100),
       city VARCHAR(100),
       street VARCHAR(255),
       postal_code VARCHAR(100),
       address TEXT,
       phone_number VARCHAR(100) UNIQUE,
       id_type VARCHAR(100),
       id_number VARCHAR(100),
       status account_status DEFAULT 'inactive',
       refresh_token TEXT,
       is_deleted BOOLEAN DEFAULT false,
       verification_token TEXT,
       verification_token_expiry_time TIMESTAMP,
       password_reset_token TEXT,
       password_reset_token_expiry_time TIMESTAMP,
       verification_email VARCHAR(255),
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE blacklisted_jwt_tokens (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL,
        user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(LOWER(email));
CREATE INDEX idx_users_verification_email ON users(LOWER(verification_email));
CREATE INDEX idx_users_phone_number ON users(phone_number);
CREATE INDEX idx_blacklisted_tokens_token ON blacklisted_jwt_tokens(token);
