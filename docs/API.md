# Dayfi API Reference

**Version:** 1.0  
**Base URL:** `{host}/api/v1`  
**Architecture:** [PAYMENTS_ARCHITECTURE.md](./PAYMENTS_ARCHITECTURE.md)  
**OpenAPI:** [openapi.yaml](./openapi.yaml) (import into Postman, Swagger UI, or Insomnia)

---

## Core principle

Every user has **one unified USD balance**. All inflows (fiat or crypto) credit USD after FX where needed. Users also have an **optional NGN balance** for local Nigeria spend (tap-to-pay / virtual cards — planned).

| Balance | Currency | Purpose |
|---------|----------|---------|
| **Primary** | USD | Receive money, send global payouts, main app balance |
| **Local spend** | NGN | Nigeria in-store / tap-to-pay (when live) |

---

## Authentication

Protected routes require:

```http
Authorization: Bearer <JWT>
```

Obtain a JWT via `POST /api/v1/auth/signup`, social login, or login flows under `/api/v1/auth/*`.

---

## Response format

### Success

```json
{
  "status": "success",
  "message": "Human-readable message",
  "code": 200,
  "data": { }
}
```

### Error

```json
{
  "status": "error",
  "code": 400,
  "message": "Description of the failure"
}
```

Common HTTP codes: `200`, `201`, `400`, `401`, `404`, `422`, `500`.

---

## Implementation status legend

| Tag | Meaning |
|-----|---------|
| **Live** | Implemented and used in production path |
| **Partial** | Implemented with limitations (see notes) |
| **Stub** | Endpoint exists; provider integration incomplete |
| **Planned** | Documented target; not built yet |

---

# Payments API (`/api/v1/payments`)

## Ledger & balances

### Get balances (primary + local spend)

**Live** · `GET /payments/wallet-details`

Ensures USD + NGN wallets exist, returns the canonical mobile shape.

**Response `data`:**

```json
{
  "primary": {
    "currency": "USD",
    "balance": 1250.5,
    "walletId": "wallet-abc..."
  },
  "localSpend": {
    "currency": "NGN",
    "balance": 50000,
    "walletId": "wallet-def..."
  },
  "wallets": [ ]
}
```

**Client guidance:** Show `primary` as the main balance. Show `localSpend` only for Nigeria local features.

---

### Feature flags

**Live** · `GET /payments/capabilities`

```json
{
  "primaryCurrency": "USD",
  "stablecoinTopup": true,
  "yellowCardReady": true,
  "greyReady": true,
  "fincraReady": false,
  "stellarDeposits": true,
  "localSpendNgn": true,
  "tapToPay": false,
  "virtualNairaCard": false
}
```

Use this before showing Bank Transfer vs Crypto vs payout corridors.

`investmentPocket`, `receiveUsBank`, `receiveCrypto` indicate PRD-aligned flows.

---

## Receive money (PRD journeys 1–2)

### Receive options

**Live** · `GET /payments/receive/options`

Returns `{ options: [{ id, label, path }] }` for **US Bank Account** and **USDC Wallet**.

### US Bank Account (Grey)

**Partial** · `GET /payments/receive/us-bank`

Creates/returns Grey VA metadata for **USD** (ACH, SWIFT, Fedwire). Inbound webhook credits unified USD.

While KYB is pending in [Grey sandbox](https://sandbox.grey.co/dashboard), account numbers may be empty until Grey activates your business accounts.

### Grey multi-currency accounts (USD, EUR, GBP)

**Live** · `GET /payments/grey/accounts`

Ensures stored rows for USD, EUR, and GBP and attempts a live sync from the Grey API (`providerSnapshot`). Use for the “Accounts” receive screen matching Grey’s USD / GBP / EUR balances.

### USDC Wallet (Stellar)

**Live** · `GET /payments/receive/crypto`

Returns `stellarAddress`, `assets: ["USDC","EURC"]`. Requires `POST /payments/wallet-provision/start` first.

**Planned:** Horizon listener auto-credits USD on deposit.

---

## Send money (PRD journey 3)

### Payout quote

**Live** · `GET /payments/send/quote?amountUsd=100&targetCurrency=GHS&feeUsd=0`

**Response `data`:**

```json
{
  "sendAmountUsd": 100,
  "targetCurrency": "GHS",
  "exchangeRate": 11,
  "beneficiaryReceives": 1100,
  "feeUsd": 0,
  "estimatedMinutes": 30
}
```

Configure rates with `POST /payments/exchange-rate` (`baseCurrency: USD`, `targetCurrency: GHS`).

### Dayfi-to-Dayfi (instant USD)

**Live** · `POST /payments/initiate-wallet-transfer`

| Field | Type | Notes |
|-------|------|-------|
| `dayfiId` | string | Recipient tag |
| `amount` | number | USD |
| `pin` | string | Required |

Instant internal transfer — no Flutterwave. Debits sender USD, credits recipient USD.

---

## Investment pocket (PRD journey 4)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/payments/investment` | Balance, APY display, risk accepted |
| POST | `/payments/investment/accept-risk` | Required before first deposit |
| POST | `/payments/investment/deposit` | `amount`, `pin`, optional `idempotencyKey` |
| POST | `/payments/investment/withdraw` | Same body shape |

Deposits debit **USD wallet** and credit `investment_pockets`. Withdrawals reverse.

---

### Create extra currency wallet

**Live** · `POST /payments/wallets`

Creates EUR, GBP, or CAD wallets (USD/NGN are auto-provisioned). USD/NGN requests idempotently return existing ledger wallets.

| Field | Type | Required | Values |
|-------|------|----------|--------|
| `currency` | string | yes | `USD`, `EUR`, `GBP`, `CAD` (NGN via onboarding) |

---

### Internal FX (USD ↔ NGN)

**Live** · `POST /payments/wallets/swap`

Move value between ledger wallets using platform `exchange_rates`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `fromCurrency` | string | yes | `USD`, `NGN`, `EUR`, `GBP`, `CAD` |
| `toCurrency` | string | yes | Must differ from `fromCurrency` |
| `amount` | number | yes | Amount in **from** currency |

**Typical flow:** `fromCurrency: USD`, `toCurrency: NGN` before local tap-to-pay spend.

**Response `data`:** `{ "success": true, "rate", "convertedAmount", "message" }`

---

### Platform exchange rates (admin / ops)

**Live** · `POST /payments/exchange-rate` · `GET /payments/exchange-rate`

Required for inflow FX (e.g. NGN→USD on Yellow Card / Grey webhooks).

| POST body | | |
|-----------|--|--|
| `baseCurrency` | string | `NGN`, `USD`, `EUR`, `GBP`, `CAD` |
| `targetCurrency` | string | Must differ from base |
| `rate` | number | Positive multiplier |
| `source` | string | optional, default `manual` |

| GET query | | |
|-----------|--|--|
| `baseCurrency` | | |
| `targetCurrency` | | |

---

## Inflows — receiving money

All successful inflows **credit the USD wallet** after conversion when the source currency is not USD.

### A. Fiat — Grey virtual accounts

| Item | Status |
|------|--------|
| Permanent VA per user (USD, EUR, GBP, NGN) | **Planned** |
| `POST /payments/grey/virtual-accounts` | **Planned** |
| Webhook → credit USD | **Partial** (stub) |

**Live webhook (stub):** `POST /payments/grey/webhook`

- Configure Grey to POST collection events here.
- When `DAYFI_GREY_*` is set, signature verification runs (HMAC TBD in provider integration).
- Parsed payload credits USD via `creditUnifiedUsdInflow`.
- **Expected payload shape (normalized):** `userId` or `customerReference`, `amount`, `currency`, `reference`.

**Planned user flow:**

1. User chooses **Bank Transfer**.
2. App calls Grey VA API (future) → shows ACH/SWIFT/SEPA/FPS/NGN account details.
3. Grey webhook → EUR/GBP/NGN converted at platform rate → USD balance updated.

---

### B. Crypto — Stellar (USDC / EURC)

| Item | Status |
|------|--------|
| Unique Stellar address per user | **Live** (on USD wallet row) |
| USDC trustline | **Live** |
| EURC | **Planned** |
| Inbound detection → credit USD | **Planned** |

**Live** · `POST /payments/wallet-provision/start`  
**Live** · `GET /payments/wallet-provision/status/:jobId`

1. `start` returns `{ job_id }` (or `status: completed` if already provisioned).
2. Poll `status` until `status` is `completed` or `failed`.
3. On first completed poll, `recovery_phrase` may be returned **once** — user must back up.
4. Stellar deposit address is stored on the **USD** wallet (via internal DB update).

**Planned user flow:**

1. User chooses **Crypto**.
2. App shows Stellar address (+ USDC; EURC when enabled).
3. Background Horizon watcher credits USD (EURC → USD FX when needed).

**Live** · `GET /payments/crypto-channels` — Yellow Card channel list for stablecoin **top-up UI** (not the same as on-chain Stellar deposit).

---

### C. Yellow Card collections

**Live** · Yellow Card Business API wrappers.

| Endpoint | Purpose |
|----------|---------|
| `GET /payments/channels` | Payout/collection channels |
| `GET /payments/networks` | Networks |
| `GET /payments/rates?currency=NGN` | Provider rates |
| `POST /payments/create-collections` | Start collection |
| `POST /payments/create-payment-request` | Linked payout |

**Collection → USD credit:** **Live** · `POST /payments/yc-webhook`

| Event | Action |
|-------|--------|
| `COLLECTION.COMPLETE` | FX if needed → **credit USD** → status `success-collection` |
| `COLLECTION.FAILED` | Update status only |
| `PAYMENT.COMPLETE` / `PAYMENT.FAILED` | Payout leg status |

Webhook body may include: `event`, `sequenceId`, `amount`, `localAmount`, `currency`, `usdAmount`.

Configure platform `exchange_rates` for non-USD collection currencies before go-live.

---

## Outflows — sending & payouts

Spend from **USD** by default. Conversion to destination currency happens at payout time (no NGN-first requirement).

| Corridor | Primary rail | Status |
|----------|--------------|--------|
| US bank (USD) | Grey | **Planned** |
| EU bank (EUR) | Grey | **Planned** |
| UK bank (GBP) | Grey | **Planned** |
| Africa (16+ countries) | Grey | **Planned** |
| Africa (20 countries, mobile money) | Yellow Card | **Partial** (`create-payment-request`) |
| Stellar USDC | Stellar SDK | **Planned** |
| Nigeria bank (NGN) | Flutterwave legacy | **Live** |

### Dayfi-to-Dayfi transfer

**Live** · `POST /payments/initiate-wallet-transfer`

Debits sender **USD** wallet (default `spendCurrency`). Requires `dayfiId`, `amount`, `pin`.

### Nigeria bank transfer (legacy)

**Live** · `POST /payments/bank-transfer`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `spendCurrency` | string | `NGN` | `NGN` = Flutterwave from NGN wallet; `USD` = requires Grey (returns 400 if not configured) |
| `amount` | number | required | |
| `accountNumber`, `bankCode`, `bankName`, `accountName` | | required | |
| `fee` | number | required | |
| `pin` | string | required | |

### Yellow Card payout

**Live** · `POST /payments/create-payment-request`  
**Live** · `POST /payments/resolve-bank` — account verification

Use after a collection or as standalone disbursement per Yellow Card docs.

---

## Local spend (Nigeria) — planned

| Feature | Status |
|---------|--------|
| Separate NGN balance | **Live** |
| USD → NGN swap | **Live** |
| Virtual Naira card | **Planned** |
| NFC tap-to-receive | **Planned** |

---

## Supporting endpoints

| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/payments/banks` | Live | Bank list (Flutterwave) |
| POST | `/payments/resolve-account` | Live | Resolve NGN account name |
| POST | `/payments/add-dayfi-id` | Live | Set Dayfi tag on USD wallet |
| GET | `/payments/validate-dayfi-id/:dayfiId` | Live | Lookup tag |
| GET | `/payments/wallet-transactions` | Live | Transaction history |
| GET | `/payments/beneficiaries` | Live | Saved beneficiaries |
| GET | `/payments/fees` | Live | Fee schedule placeholder |
| POST | `/payments/charge-card` | Live | Legacy card charge (Flutterwave) |
| POST | `/payments/verify-charge` | Live | OTP verify |
| POST | `/payments/verify-payment` | Live | Verify + credit wallet |
| POST | `/payments/webhook` | Live | Legacy Flutterwave transfer webhook |

### Wallet transactions query

`GET /payments/wallet-transactions`

| Query | Type | Values |
|-------|------|--------|
| `status` | string | `pending-collection`, `success-collection`, `failed-collection`, `pending-payment`, `success-payment`, `failed-payment` |
| `startDate`, `endDate` | ISO date | optional |
| `search` | string | optional |
| `page` | number | default `1` |
| `limit` | number | default `10`, max `100` |
| `sortOrder` | string | `asc`, `desc` |

---

## Webhooks (server-to-server)

No `Authorization` header unless noted. Configure URLs in provider dashboards.

| Provider | URL | Status |
|----------|-----|--------|
| Grey | `POST /api/v1/payments/grey/webhook` | Partial |
| Yellow Card | `POST /api/v1/payments/yc-webhook` | Live |
| Flutterwave (legacy) | `POST /api/v1/payments/webhook` | Live |

### Grey webhook

```json
{
  "userId": "user-xxx",
  "amount": 100,
  "currency": "EUR",
  "reference": "grey-tx-123"
}
```

Also accepts `customerReference`, `receivedAmount`, `transactionReference`, `id`.

### Yellow Card webhook

```json
{
  "event": "COLLECTION.COMPLETE",
  "sequenceId": "uuid",
  "amount": 50000,
  "currency": "NGN"
}
```

---

## Mobile integration flows

### Home screen

```
GET /payments/wallet-details  →  show primary.balance (USD)
GET /payments/capabilities    →  gate features
```

### Receive — Bank Transfer

```
(Planned) GET/POST Grey VA → show account details
         User sends fiat
         Grey → POST /payments/grey/webhook → USD credited
```

### Receive — Crypto

```
POST /payments/wallet-provision/start
GET  /payments/wallet-provision/status/:jobId  → stellar address
(Planned) poll or push when on-chain deposit credits USD
```

### Receive — Yellow Card collection

```
POST /payments/create-collections
→ user pays via channel
→ yc-webhook COLLECTION.COMPLETE → USD credited
```

### Fund NGN for local spend

```
POST /payments/wallets/swap
{ "fromCurrency": "USD", "toCurrency": "NGN", "amount": 50 }
```

### Send — global (target)

```
spendCurrency omitted or USD
Grey / Yellow Card payout APIs (see Outflows)
Debit USD after FX at payout time
```

### Send — Nigeria bank (today)

```
POST /payments/bank-transfer
{ "spendCurrency": "NGN", ... }
```

---

## Environment variables

See [.env.example](../.env.example).

| Variable | Rail |
|----------|------|
| `DAYFI_GREY_API_KEY`, `DAYFI_GREY_BASE_URL`, `DAYFI_GREY_WEBHOOK_SECRET` | Grey |
| `DAYFI_YELLOWCARD_*` | Yellow Card |
| `WALLET_ENCRYPTION_KEY`, `STELLAR_*` | Stellar / EVM |
| `DAYFI_STABLECOIN_TOPUP_ENABLED` | Yellow Card stablecoin UI |

---

## Auth API (summary)

Base: `/api/v1/auth`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/signup` | Register |
| POST | `/validate-email` | Email check |
| POST | `/google-auth`, `/apple-auth` | Social |
| PATCH | `/update-profile/:user_id` | Profile; creates wallets if missing |
| POST | `/verify-sms-otp` | Phone verify; creates USD + NGN wallets |

Onboarding creates **USD + NGN** ledger wallets via `ensureUserLedgerWallets`.

---

## Production checklist

- [ ] Run migrations: `npm run migrate:up`
- [ ] Seed FX: `NGN→USD`, `USD→GHS`, etc. via `POST /payments/exchange-rate`
- [ ] Set `DAYFI_GREY_*`, `DAYFI_YELLOWCARD_*`, `WALLET_ENCRYPTION_KEY`
- [ ] Register webhooks: `/payments/grey/webhook`, `/payments/yc-webhook`
- [ ] Whitelist Yellow Card outbound IP on Railway
- [ ] Require transaction PIN before send/invest (`users.transaction_pin`)

## Changelog

| Date | Change |
|------|--------|
| 2026-05-26 | Prod ledger: idempotent `ledger_movements`, P2P USD, receive/send/investment APIs, bug fixes |
| 2026-05-26 | Unified USD ledger; wallet-details shape; Grey webhook stub; YC collection credits USD |
