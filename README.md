# Dayfi Backend

API server for Dayfi payments and authentication.

## Payments model

**One Global USD Hub** — all inflows credit USD; send globally from USD; optional NGN for local spend.

| Doc | Purpose |
|-----|---------|
| [docs/API.md](docs/API.md) | Full API reference (mobile + ops) |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3 — import to Postman |
| [docs/PAYMENTS_ARCHITECTURE.md](docs/PAYMENTS_ARCHITECTURE.md) | Rails, services, DB |

**Rails:** Grey (primary fiat), Yellow Card (Africa payouts), Stellar (USDC receive).

## Development

```bash
cp .env.example .env
npm run db:up
npm run migrate:up
npm run dev
```

## Migrations

```bash
npm run migrate:up
```

Migrations: `20260526120000-unified-usd-ledger`, `20260526140000-prod-ledger`, `20260526150000-rename-fincra-to-grey`.

Grey smoke test: `npm run grey:smoke`
