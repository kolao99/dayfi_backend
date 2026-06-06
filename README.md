# Dayfi Backend

API server for Dayfi — payments, authentication, DayBudget (DayFlow), and in-app notifications.

**Production:** `https://api.dayfi.co/api/v1` · Deploy: [docs/DEPLOY_VPS.md](docs/DEPLOY_VPS.md)

## Payments model

**One Global USD Hub** — all inflows credit USD; send globally from USD; optional NGN for local spend.

| Doc | Purpose |
|-----|---------|
| [docs/API.md](docs/API.md) | Full API reference (mobile + ops) |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3 — import to Postman |
| [docs/PAYMENTS_ARCHITECTURE.md](docs/PAYMENTS_ARCHITECTURE.md) | Rails, services, DB |
| [docs/MOBILE_INTEGRATION.md](docs/MOBILE_INTEGRATION.md) | Consumer app wiring |
| [docs/DEPLOY_VPS.md](docs/DEPLOY_VPS.md) | VPS deploy runbook |
| [docs/TEST_PRODUCTION.md](docs/TEST_PRODUCTION.md) | Smoke tests on prod |

### Rails

Grey (primary fiat), Yellow Card (Africa payouts), Stellar (USDC receive), Flutterwave (NGN VA + bills + NGN bank send).

### Transaction history

- **`GET /payments/wallet-transactions`** — mobile History tab; joins `ledger_movements` for deposit FX and bill metadata.
- **Bill pays** — action-specific labels (e.g. **Airtime Topup**, **MTN Airtime Topup**; refunds **Airtime Topup Refund**). Never generic “Bill payment”. Metadata: `categoryCode`, `billerName`, `itemName`, `customerId`, **`ngnAmount`** (NGN face value) on ledger + `ledger_metadata` / `ngn_amount` in the API response.
- **History FX line (mobile)** — bill pay, refund, and NGN deposit rows show **`₦100 = $0.07`** (whole naira, USD to 2 dp). Refunds store `ngnAmount`; legacy rows fall back to the original bill debit.
- **First page fetch** — backfills missing rows from `ledger_movements` and repairs legacy P2P, bill, and Flutterwave deposit labels (idempotent).

### Bills (Flutterwave)

`GET /payments/bills/categories` → billers → items → `POST /payments/bills/pay` (debits USD, pays in NGN). Failed payout reverses USD with a labelled refund credit (`ngnAmount` on reversal metadata).

### In-app inbox (Phase 1)

Deposit, bank send, bill pay, and P2P write to `user_notifications`. Mobile polls `GET /notifications` and shows an unread badge. Push (FCM) is Phase 2.

### DayEarn

**USD pots only** (7% APY). Fund from global USD wallet. `GET/POST /payments/dayearn/*`.

### DayBudget (DayFlow)

`/api/v1/dayflow/*` — AI budget chat, plans, templates, and **scheduled autopay** (recurring sends/bills). All data scoped by authenticated `user_id`. Mobile wallet balance in **USD** (2 dp).

## Development

```bash
cp deploy/.env.example .env   # local Docker dev (or deploy/.env on VPS)
npm run db:up
npm run migrate:up
npm run dev
```

API listens on `DAYFI_PORT` (default **3000**).

## Deploy (VPS)

```bash
./scripts/deploy-vps.sh
```

See [deploy/README.md](deploy/README.md) and [docs/DEPLOY_VPS.md](docs/DEPLOY_VPS.md).

## Migrations

```bash
npm run migrate:up
```

Recent: `20260526120000-unified-usd-ledger`, `20260526140000-prod-ledger`, `20260526150000-rename-fincra-to-grey`.

## Smoke tests

```bash
npm run smoke:providers   # egress IP + Flutterwave + Yellow Card
npm run grey:smoke
npm run fw:smoke
npm run yc:smoke
npm run egress-ip
```

Production checklist: [docs/TEST_PRODUCTION.md](docs/TEST_PRODUCTION.md).
