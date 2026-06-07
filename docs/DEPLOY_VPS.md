# Deploy Dayfi API on a VPS (static IP for Flutterwave & Yellow Card)

Railway **free** tier uses **dynamic outbound IPs**, which breaks Flutterwave and Yellow Card IP whitelisting. Run the API on a VPS with a **fixed IPv4**; keep **Postgres on Railway** if you like.

Target hostname: **`https://api.dayfi.co`** (aligns with mobile prod `flavors.dart`).

---

## 1. Provision VPS

Recommended: **Hetzner CX23** (Falkenstein or Helsinki) — ~€3.99/mo, IPv4 included.

Alternatives: Contabo Cloud VPS 10, Vultr, DigitalOcean.

- Ubuntu 24.04
- Note the VPS **public IPv4** in the provider panel

---

## 2. Whitelist egress IP

On the VPS (after deploy) or from your laptop:

```bash
npm run egress-ip
# or
curl -s "https://api.dayfi.co/api/v1/health/egress-ip?token=YOUR_OPS_TOKEN"
```

Add that IPv4 to:

| Provider | Where |
|----------|--------|
| **Flutterwave** | Dashboard → Settings → Whitelisted IP addresses (OTP on live) |
| **Yellow Card** | Support / dashboard allowlist |

---

## 3. DNS

| Type | Name | Value |
|------|------|--------|
| A | `api` | VPS public IPv4 |

Wait for DNS before starting Caddy (Let's Encrypt needs valid DNS).

---

## 4. VPS setup (SSH)

```bash
sudo apt update && sudo apt install -y git docker.io docker-compose-v2
sudo usermod -aG docker $USER
# log out and back in
```

Clone and configure:

```bash
git clone <your-repo-url> dayfi_backend && cd dayfi_backend
cp deploy/.env.example deploy/.env
nano deploy/.env   # paste production vars from Railway
```

Copy **all** Railway API variables into `deploy/.env`, especially:

- `DAYFI_DATABASE_URL` — must be Railway Postgres **public** URL (`*.railway.app`), **not** `postgres.railway.internal` (internal only works on Railway). In Railway: Postgres service → **Connect** → enable **Public networking** → copy URL. Append `?sslmode=require` if connection fails.
- `DAYFI_JWT_SECRET`, `WALLET_ENCRYPTION_KEY`
- `DAYFI_FLUTTERWAVE_*` (live keys)
- `DAYFI_YELLOWCARD_*`
- `DAYFI_GREY_*`, Twilio, Resend, Stellar, Groq, etc.

Set:

```bash
DAYFI_APP_URL=https://api.dayfi.co
DAYFI_SMILE_CALLBACK_URL=https://api.dayfi.co/api/v1/kyc/smile/webhook
DAYFI_OPS_TOKEN=<random>   # optional, for /health/egress-ip
```

Edit `deploy/Caddyfile` if your hostname differs.

---

## 5. Deploy

```bash
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api
```

Smoke tests:

```bash
curl -s https://api.dayfi.co/api/v1/health
curl -s https://api.dayfi.co/api/v1/health/ready
npm run egress-ip
npm run yc:smoke    # from repo root with deploy/.env copied or symlinked
```

---

## 6. Webhooks (required)

Register these URLs at each provider (replace host if needed):

| Provider | URL |
|----------|-----|
| Yellow Card | `https://api.dayfi.co/api/v1/payments/yc-webhook` |
| Flutterwave | `https://api.dayfi.co/api/v1/payments/webhooks/flutterwave` |
| Grey | `https://api.dayfi.co/api/v1/payments/grey/webhook` |
| Smile | `https://api.dayfi.co/api/v1/kyc/smile/webhook` |

---

## 7. Mobile app

Prod/pilot `baseUrl` is `https://api.dayfi.co/api/v1` in `dayfi-mobile-app/lib/flavors.dart`.

VS Code: **Flutter Dev (api.dayfi.co)** or **Flutter Pilot/Prod** — see `docs/TEST_PRODUCTION.md`.

```bash
flutter run --flavor pilot --dart-define=FLAVOR=pilot
```

Ship a new **mobile build** when backend history/status/notification changes land — History and People tabs depend on API + app UI together.

After backend deploy, open **History** and pull to refresh once (page-1 repair runs server-side).

---

## 9. Redeploy after backend changes

From your Mac (repo root):

```bash
./scripts/deploy-vps.sh
```

This rsyncs the tree (including `docs/`) and rebuilds the API container. Verify:

```bash
curl -s https://api.dayfi.co/api/v1/health/ready
```

Then rebuild/run the consumer Flutter app against `api.dayfi.co`.

---

## 8. Cutover from Railway API

1. Confirm VPS health + one Flutterwave + one Yellow Card call succeed.
2. **Stop** the Railway **API** service (keep **Postgres** running).
3. Do **not** run two production APIs against the same DB.

Rollback: point DNS or app back to Railway URL temporarily (IP whitelist on Railway remains fragile).

---

## Health endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/v1/health` | None |
| GET | `/api/v1/health/ready` | None (DB check) |
| GET | `/api/v1/health/egress-ip` | `DAYFI_OPS_TOKEN` header `X-Dayfi-Ops-Token` or `?token=` if set |

---

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Do not expose port 3000 publicly; Caddy proxies to the container network.
