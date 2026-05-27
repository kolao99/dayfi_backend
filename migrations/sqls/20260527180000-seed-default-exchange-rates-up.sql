-- Default FX pairs for home total, swap, and quotes (test/dev approximations).
INSERT INTO exchange_rates (base_currency, target_currency, rate, source)
VALUES
  ('NGN', 'USD', 0.000650, 'platform_default'),
  ('GBP', 'USD', 1.270000, 'platform_default'),
  ('EUR', 'USD', 1.080000, 'platform_default'),
  ('USD', 'NGN', 1540.000000, 'platform_default'),
  ('USD', 'GBP', 0.790000, 'platform_default'),
  ('USD', 'EUR', 0.930000, 'platform_default')
ON CONFLICT (base_currency, target_currency) DO NOTHING;
