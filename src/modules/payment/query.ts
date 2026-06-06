type PaymentQueries = {
  createWallet: string;
  updateWalletWithDayfiId: string;
  createWalletTransaction: string;
  createCardWalletTransaction: string;
  updateWalletTransactionStatus: string;
  getWalletByDayfiId: string;
  getWalletByUserId: string;
  getUsdWalletByUserId: string;
  getWalletsByUserId: string;
  getWalletTransactionById: string;
  updateTransactionStatusToProcessing: string;
  getWalletTransactionByReference: string;
  creditWalletBalance: string;
  debitWalletBalance: string;
  markTransactionSuccessful: string;
  markTransferSuccessful: string;
  fetchWalletTransactions: string;
  fetchWalletTransactionsCount: string;
  markTransferFailed: string;
  fetchUserWalletByCurrency: string;
  createOtherWallet: string;
  fetchExchangeRate: string;
  createExchangeRate: string;
  getUserWalletByCurrency: string;
  debitWallet: string;
  creditWallet: string;
  logSwap: string;
  createSource: string;
  updateWalletTransaction: string;
  updateWalletTransactionPayment: string;
  updateTransactionToPayment: string;
  createBeneficiary: string;
  getUserBeneficiaries: string;
  getUserBeneficiariesCount: string;
};

export const paymentQueries: PaymentQueries = {
  createWallet: `
    INSERT INTO wallets (
      user_id,
      wallet_reference,
      account_name,
      account_number,
      bank_code,
      bank_name,
      currency,
      provider,
      balance
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'flutterwave', 0.00)
    RETURNING *;
  `,

  updateWalletWithDayfiId: `
    UPDATE wallets
    SET dayfi_id = $1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $2
      AND currency = 'USD'
    RETURNING *;
  `,

  createWalletTransaction: `
        INSERT INTO wallet_transactions (
            id,
            status,
            reason,
            send_amount,
            send_channel,
            send_network,
            beneficiary_id,
            user_id,
            source_id,
            timestamp
        ) VALUES (
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
                 )
            RETURNING *;
    `,

  createCardWalletTransaction: `
  INSERT INTO wallet_transactions (
    user_id,
    recipient_wallet_id,
    amount,
    type,
    status,
    reference,
    narration,
    metadata,
    initiated_by,
    card_last4,
    card_type,
    card_brand,
    card_country,
    card_token,
    card_transaction_ref
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
  RETURNING *;
`,

  updateTransactionStatusToProcessing: `
  UPDATE wallet_transactions
  SET status = 'processing', updated_at = CURRENT_TIMESTAMP
  WHERE card_transaction_ref = $1
  RETURNING *;
`,

  updateWalletTransactionStatus: `
    UPDATE wallet_transactions
    SET status = $1, updated_at = CURRENT_TIMESTAMP
    WHERE reference = $2
    RETURNING *;
  `,

  getWalletByDayfiId: `
    SELECT * FROM wallets
    WHERE LOWER(TRIM(BOTH '@' FROM COALESCE(dayfi_id, ''))) = LOWER(TRIM(BOTH '@' FROM $1))
    LIMIT 1;
  `,

  getWalletByUserId: `
    SELECT * FROM wallets
    WHERE user_id = $1
    ORDER BY CASE currency WHEN 'USD' THEN 0 WHEN 'NGN' THEN 1 ELSE 2 END, created_at ASC
    LIMIT 1;
  `,

  getUsdWalletByUserId: `
    SELECT * FROM wallets WHERE user_id = $1 AND currency = 'USD' LIMIT 1;
  `,

  getWalletsByUserId: `
    SELECT * FROM wallets
    WHERE user_id = $1
    ORDER BY CASE currency WHEN 'USD' THEN 0 WHEN 'NGN' THEN 1 ELSE 2 END, created_at ASC;
  `,

  getWalletTransactionById: `
    SELECT * FROM wallet_transactions WHERE id = $1 LIMIT 1;
  `,

  getWalletTransactionByReference: `
  SELECT * FROM wallet_transactions
  WHERE reference = $1
`,

  creditWalletBalance: `
  UPDATE wallets
  SET balance = balance + $1,
      updated_at = CURRENT_TIMESTAMP
  WHERE wallet_id = $2
  RETURNING balance
`,

  debitWalletBalance: `
  UPDATE wallets
  SET balance = balance - $1,
      updated_at = CURRENT_TIMESTAMP
  WHERE wallet_id = $2
  RETURNING balance
`,

  markTransactionSuccessful: `
  UPDATE wallet_transactions
  SET status = 'success',
      balance = $1,
      card_type = $3,
      card_brand = $4,
      card_country = $5,
      card_token = $6,
      card_last4 = $7,
      updated_at = CURRENT_TIMESTAMP
  WHERE reference = $2
  RETURNING *;
`,

  markTransferSuccessful: `
  UPDATE wallet_transactions
  SET status = $3,
      balance = $1,
      fees = $4,
      updated_at = CURRENT_TIMESTAMP
  WHERE reference = $2
  RETURNING *;
`,

  markTransferFailed: `
    UPDATE wallet_transactions
    SET status = $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE reference = $1
    RETURNING *;
  `,

  fetchWalletTransactions: `
        SELECT
            wt.id,
            wt.send_channel,
            wt.send_network,
            wt.send_amount,
            wt.receive_channel,
            wt.receive_network,
            wt.receive_amount,
            0::numeric AS fees,
            wt.ledger_currency,
            wt.activity_kind,
            wt.external_reference,
            wt.status,
            wt.reason,
            wt.timestamp,
            COALESCE(
              (lm.metadata->>'originalAmount')::numeric,
              CASE
                WHEN wt.receive_channel = 'bank'
                  AND wt.activity_kind = 'deposit'
                  AND wt.ledger_currency = 'NGN'
                THEN wt.receive_amount
                ELSE NULL
              END
            ) AS ngn_amount,
            COALESCE(lm.usd_equivalent, wt.send_amount) AS usd_credited,
            CASE
              WHEN (lm.metadata->>'rate')::numeric > 0
                AND (lm.metadata->>'rate')::numeric < 1
              THEN (1 / (lm.metadata->>'rate')::numeric)
              ELSE (lm.metadata->>'rate')::numeric
            END AS fx_ngn_to_usd,
            json_build_object(
                    'id', b.id,
                    'name', b.name,
                    'country', b.country,
                    'phone', b.phone,
                    'address', b.address,
                    'dob', b.dob,
                    'email', b.email,
                    'idNumber', b.id_number,
                    'idType', b.id_type
            ) AS beneficiary,
            json_build_object(
                    'id', s.id,
                    'accountType', s.account_type,
                    'accountNumber', s.account_number,
                    'networkId', s.network_id,
                    'beneficiaryId', s.beneficiary_id
            ) AS source
        FROM wallet_transactions wt
                 LEFT JOIN source s ON wt.source_id = s.id
                 LEFT JOIN beneficiaries b ON wt.beneficiary_id = b.id
                 LEFT JOIN ledger_movements lm
                   ON lm.external_reference = wt.external_reference
                  AND lm.user_id = wt.user_id
                  AND lm.direction = 'credit'
        WHERE wt.user_id = $1
          AND ($2 IS NULL OR wt.status = $2)
          AND ($3 IS NULL OR wt.timestamp::date >= $3::date)
          AND ($4 IS NULL OR wt.timestamp::date <= $4::date)
          AND ($5 IS NULL OR b.name ILIKE '%' || $5 || '%' OR wt.reason ILIKE '%' || $5 || '%')
        ORDER BY
            CASE WHEN $8 = 'ASC' THEN wt.timestamp END ASC NULLS LAST,
            CASE WHEN $8 = 'DESC' THEN wt.timestamp END DESC NULLS LAST
            LIMIT $6
        OFFSET $7;
    `,

  fetchWalletTransactionsCount: `
        SELECT COUNT(*) AS total
        FROM wallet_transactions wt
                 LEFT JOIN source s ON wt.source_id = s.id
                 LEFT JOIN beneficiaries b ON wt.beneficiary_id = b.id
        WHERE wt.user_id = $1
          AND ($2 IS NULL OR wt.status = $2)
          AND ($3 IS NULL OR wt.timestamp::date >= $3::date)
          AND ($4 IS NULL OR wt.timestamp::date <= $4::date)
          AND ($5 IS NULL OR b.name ILIKE '%' || $5 || '%' OR wt.reason ILIKE '%' || $5 || '%');
    `,

  fetchUserWalletByCurrency: `
    SELECT *
    FROM wallets
    WHERE user_id = $1
    AND currency = $2;
  `,

  createOtherWallet: `
    INSERT INTO wallets (user_id, balance, wallet_reference, currency, provider, created_at, updated_at)
    VALUES ($1, 0.00, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING *;
  `,

  fetchExchangeRate: `SELECT rate FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2`,

  createExchangeRate: `
    INSERT INTO exchange_rates (base_currency, target_currency, rate, source)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (base_currency, target_currency)
    DO UPDATE SET rate = EXCLUDED.rate, updated_at = CURRENT_TIMESTAMP
    RETURNING *;
  `,

  getUserWalletByCurrency: `
    SELECT * FROM wallets
    WHERE user_id = $1 AND currency = $2
    LIMIT 1
  `,

  debitWallet: `
    UPDATE wallets SET balance = balance - $1 WHERE wallet_id = $2
  `,
  creditWallet: `
    UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2
  `,

  logSwap: `
    INSERT INTO wallet_currency_swaps (
      user_id, from_wallet_id, to_wallet_id,
      from_currency, to_currency, amount,
      exchange_rate, converted_amount
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,

  createSource: `
  INSERT INTO source (
    account_type,
    account_number,
    network_id,
    beneficiary_id
  ) VALUES (
    $1, $2, $3, $4
  )
  RETURNING *;
`,
  updateWalletTransaction: `
  UPDATE wallet_transactions
  SET status = $2,
      timestamp = NOW()
  WHERE id = $1
  RETURNING *;
`,

  updateWalletTransactionPayment: `
  UPDATE wallet_transactions
  SET status = $2,
      timestamp = NOW()
  WHERE payment_sequence_id = $1
  RETURNING *;
`,

  updateTransactionToPayment: `
  UPDATE wallet_transactions
  SET status = $2,
      reason = $3,
      send_amount = $4,
      send_channel = $5,
      send_network = $6,
      payment_sequence_id = $7,
      collection_sequence_id = $8,
      timestamp = NOW()
  WHERE id = $1
  RETURNING *;
`,

  createBeneficiary: `
  INSERT INTO beneficiaries (
    name,
    country,
    phone,
    address,
    dob,
    email,
    id_number,
    id_type,
    user_id
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
  )
  RETURNING *;
`,

  getUserBeneficiaries: `
  SELECT *
  FROM beneficiaries
  WHERE user_id = $1
  ORDER BY name ASC
  LIMIT $2
  OFFSET $3;
`,

  getUserBeneficiariesCount: `
  SELECT COUNT(*) as total
  FROM beneficiaries
  WHERE user_id = $1;
`,
};
