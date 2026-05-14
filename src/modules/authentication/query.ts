type AuthQueries = {
  getUserWithProfile: string;
  getUserByPhoneNumber: string;
  createUser: string;
  createAppleUser: string;
  setAppleRefreshToken: string;
  updateProfile: string;
  updateUserOTP: string;
  updateUserPassword: string;
  getUserById: string;
  addTokenToBlacklist: string;
  checkIfTokenIsBlacklisted: string;
  clearUserOTP: string;
  updateUserLevel: string;
  changeUserPassword: string;
  updateUserTransactionPin: string;
};

export const authQueries: AuthQueries = {
  getUserWithProfile: `
    SELECT *
    FROM users
    WHERE ((($1 IS NOT NULL AND (
    LOWER(email) = LOWER(TRIM($1))
    OR refresh_token = $1
    OR verification_token = $1
    OR user_id = $1
  )))
  OR ($2 IS NOT NULL AND LOWER(verification_email) = LOWER(TRIM($2))))
  AND user_type = 'user'
  `,

  getUserById: `
    SELECT *
    FROM users u
    WHERE user_id  = $1;
    `,

  getUserByPhoneNumber: `
    SELECT *
    FROM users
    WHERE phone_number = $1;
    `,

  createUser: `
    INSERT INTO users (email, password, first_name, last_name, middle_name, user_type)
    VALUES ($1, $2, $3, $4, $5, 'user')
    RETURNING user_id, email, created_at, updated_at;
`,

  createAppleUser: `
    INSERT INTO users (email, password, first_name, last_name, middle_name, user_type, refresh_token, status)
    VALUES (LOWER(TRIM($1)), $2, $3, $4, COALESCE(NULLIF(TRIM($5), ''), ''), 'user', $6, 'active'::account_status)
    RETURNING *;
`,

  setAppleRefreshToken: `
    UPDATE users
    SET refresh_token = $1, updated_at = NOW()
    WHERE user_id = $2
    RETURNING *;
`,

  updateProfile: `
      UPDATE users
      SET
          gender = $1,
          date_of_birth = $2,
          country = $3,
          state = $4,
          street = $5,
          city = $6,
          postal_code = $7,
          address = $8,
          phone_number = $9,
          id_type = $10,
          id_number = $11,
          updated_at = NOW()
      WHERE user_id = $12
          RETURNING *;
  `,

  updateUserOTP: `
    UPDATE users
    SET verification_token = $1, verification_token_expiry_time = $2, refresh_token = $3
    WHERE LOWER(email) = LOWER(TRIM($4))  AND user_type = 'user'
    RETURNING user_id, email, first_name, last_name, verification_token, refresh_token
    `,

  clearUserOTP: `
      UPDATE users
      SET "verification_token" = NULL, "verification_token_expiry_time" = NULL, status = 'active'
      WHERE "verification_token" = LOWER(TRIM($1))
          RETURNING *;
  `,

  updateUserPassword: `
        UPDATE users
        SET
            password = $1,
            password_reset_token = NULL,
            password_reset_token_expiry_time = NULL,
            status = 'active'
        WHERE user_id = $2
        RETURNING *`,

  addTokenToBlacklist: `
    INSERT INTO blacklisted_jwt_tokens (token, user_id, expires_at, reason)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `,

  checkIfTokenIsBlacklisted: `
    SELECT *
    FROM blacklisted_jwt_tokens
    WHERE token = $1;
  `,

  updateUserLevel: `
        UPDATE users
        SET
            level = $1
        WHERE user_id = $2
        RETURNING *`,

  changeUserPassword: `
        UPDATE users
        SET
          password = $2
        WHERE user_id = $1
        RETURNING *`,

  updateUserTransactionPin: `
        UPDATE users
        SET
          transaction_pin = $2
        WHERE user_id = $1
        RETURNING *`,
};
