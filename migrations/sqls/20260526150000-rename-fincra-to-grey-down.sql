ALTER INDEX IF EXISTS idx_grey_virtual_accounts_user
  RENAME TO idx_fincra_virtual_accounts_user;

ALTER TABLE IF EXISTS grey_virtual_accounts RENAME TO fincra_virtual_accounts;
