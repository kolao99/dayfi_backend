# Production deploy (VPS)

See **[docs/DEPLOY_VPS.md](../docs/DEPLOY_VPS.md)** for the full runbook and **[docs/TEST_PRODUCTION.md](../docs/TEST_PRODUCTION.md)** for post-deploy checks.

## Quick start

```bash
cp deploy/.env.example deploy/.env   # fill secrets (see below)
nano deploy/Caddyfile                 # hostname → api.dayfi.co
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
```

## Redeploy from Mac (recommended)

Syncs latest backend + docs and rebuilds the API:

```bash
./scripts/deploy-vps.sh
```

After deploy:

1. `curl -s https://api.dayfi.co/api/v1/health/ready`
2. Rebuild the **consumer** Flutter app (`dayfi-mobile-app`) — History status labels, YC send titles, and People bank names need both API + app.
3. In app: **History** → pull to refresh (runs server-side repair for failed bill/YC rows).

## Env highlights (`deploy/.env`)

| Variable | Purpose |
|----------|---------|
| `DAYFI_DATABASE_URL` | Railway Postgres **public** URL |
| `DAYFI_TRANSFER_FEE_USD` | Flat send fee (default `0.05`) — exposed as `fees` on wallet transactions |
| `DAYFI_YELLOWCARD_*` | Cross-border bank send (wallet-funded) |
| `DAYFI_FLUTTERWAVE_*` | NGN banks, bills, VA deposits |
| `DAYFI_APP_URL` | `https://api.dayfi.co` |

Full list: [deploy/.env.example](./.env.example)
