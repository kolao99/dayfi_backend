# Mobile app ↔ backend wiring

## Two different apps / backends on your Desktop

| Folder | Role | API | Port (typical) |
|--------|------|-----|----------------|
| **`dayfi_backend`** | Consumer wallet API (Grey USD hub, receive, send, invest, bills, DayBudget) | `/api/v1/payments/*`, `/api/v1/auth/*`, `/api/v1/dayflow/*`, `/api/v1/notifications/*` | **3000** |
| **`dayfi`** (Flutter) | **Merchant POS** (checkout, sales, tap-to-pay) | `/v1/wallet/balances`, `/v1/sales`, … | **3001** (`dayfi/backend` Node) |

They are **not** connected today. The merchant Flutter app does **not** call `dayfi_backend`.

## Consumer app (target: Grey-style home)

Use **`dayfi_backend`** with JWT from `/api/v1/auth/*`.

### Home screen — total balance in USD

```http
GET /api/v1/payments/wallet-details
Authorization: Bearer <token>
```

**Use `data.totalAvailableBalance`** for the hero card (like Grey “Total available balance”):

```json
{
  "totalAvailableBalance": {
    "currency": "USD",
    "amount": 1250.5,
    "formatted": "$1,250.50"
  },
  "primary": { "currency": "USD", "balance": 1250.5, "walletId": "..." },
  "localSpend": { "currency": "NGN", "balance": 50000, "walletId": "..." }
}
```

- Show **only `totalAvailableBalance`** on home (USD).
- Show **NGN** on a secondary “Spend in Nigeria” screen (from `localSpend`), not as a second main balance.

### Accounts list (Grey sandbox parity)

```http
GET /api/v1/payments/grey/accounts
```

```json
{
  "totalAvailableBalance": { "currency": "USD", "amount": 0, "formatted": "$0.00" },
  "operatingAccounts": [
    {
      "currency": "USD",
      "name": "United States Dollar",
      "kybStatus": "processing",
      "statusLabel": "Your bank account is processing...",
      "formattedBalance": "$0.00",
      "creditsTo": "USD"
    },
    {
      "currency": "NGN",
      "name": "Nigerian Naira",
      "kybStatus": "request_bank_account",
      "statusLabel": "Request bank account",
      "formattedBalance": "₦0.00",
      "creditsTo": "USD"
    }
  ]
}
```

`kybStatus` values:

| Status | UI copy |
|--------|---------|
| `processing` | Your bank account is processing... (USD) |
| `request_bank_account` | Request bank account (NGN) |
| `pending` | Balance / awaiting setup (EUR, GBP) |
| `active` | Show account number + live balance |

### NGN deposits → USD

Grey NGN webhook → `POST /api/v1/payments/grey/webhook` → FX → **credits USD** (not NGN wallet).

Internal NGN wallet is funded via `POST /payments/wallets/swap` (USD → NGN) for tap-to-pay.

### Transaction history

```http
GET /api/v1/payments/wallet-transactions?page=1&limit=20&sortOrder=DESC
Authorization: Bearer <token>
```

- Filter by `ledger_currency=USD` on the client for the global wallet tab.
- **Bill pays:** use `reason`, `beneficiary.name`, and `ledger_metadata` (`categoryCode`, `billerName`, …) for titles like “MTN Airtime” — not generic “Bill payment”.
- **NGN deposits:** subtitle should say “received”, not “sent”; use `ngn_amount` + `usd_credited`.
- First request on page 1 triggers server-side backfill/repair for legacy rows.

### Notifications (Phase 1)

```http
GET /api/v1/notifications
GET /api/v1/notifications/unread-count
PUT /api/v1/notifications/read-all
PUT /api/v1/notifications/:id
```

Refresh on Home pull-to-refresh and when returning from the inbox screen.

### Bills

```http
GET  /api/v1/payments/bills/categories
POST /api/v1/payments/bills/pay
```

Debits USD; shows in history as a labelled debit (outgoing). Failed pays reverse with a labelled credit.

### DayBudget (DayFlow)

```http
GET  /api/v1/dayflow/plan
GET  /api/v1/dayflow/dashboard
POST /api/v1/dayflow/chat
```

Plans and flows are **per user on the server**. Mobile must cache chat/plan locally **scoped to the logged-in user id** — never use device-global SharedPreferences keys across accounts.

## Merchant app (`dayfi` Flutter)

Continues to use **`dayfi/backend`**:

- `GET /v1/wallet/balances` — merchant ledger (fiat + crypto)
- Not the unified consumer USD model

To align merchant app with Grey hub would require a separate integration project.

## Checklist for consumer mobile

- [ ] `API_BASE_URL=https://api.dayfi.co/api/v1` (or local `:3000/api/v1`)
- [ ] Home calls `GET /payments/wallet-details` → `totalAvailableBalance`
- [ ] Home refreshes `GET /notifications/unread-count` on pull / resume
- [ ] History uses bill-specific labels from `ledger_metadata` / `reason`
- [ ] DayBudget local cache keyed by user id
- [ ] Receive calls `GET /payments/grey/accounts`
- [ ] Do **not** sum USD+NGN on home screen
