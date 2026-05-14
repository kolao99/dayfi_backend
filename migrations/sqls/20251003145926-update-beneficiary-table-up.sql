/* Replace with your SQL commands */
ALTER TABLE beneficiaries
    ALTER COLUMN id SET DEFAULT 'ben-' || LOWER(REPLACE(CAST(uuid_generate_v4() AS varchar(36)), '-', ''));
