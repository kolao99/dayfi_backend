# Production deploy (VPS)

See **[docs/DEPLOY_VPS.md](../docs/DEPLOY_VPS.md)** for the full runbook.

Quick start:

```bash
cp deploy/.env.example deploy/.env   # fill secrets
nano deploy/Caddyfile                 # hostname → api.dayfi.co
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
```
