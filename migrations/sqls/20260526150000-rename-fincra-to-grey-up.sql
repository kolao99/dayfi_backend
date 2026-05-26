-- Rename Fincra virtual account storage to Grey (primary fiat rail).

ALTER TABLE IF EXISTS fincra_virtual_accounts RENAME TO grey_virtual_accounts;

ALTER INDEX IF EXISTS idx_fincra_virtual_accounts_user
  RENAME TO idx_grey_virtual_accounts_user;
