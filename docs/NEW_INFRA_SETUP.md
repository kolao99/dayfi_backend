# New infrastructure setup (Railway + Hetzner)

Use this when **`api.dayfi.co` is down** (old VPS unreachable) or Postgres credentials are dead.

**Status (2026-08-18):**

| Component | State |
|-----------|--------|
| Old Hetzner `88.99.122.244` | **Unreachable** — SSH/ping timeout; DNS still points here |
| Old Railway Postgres `yamanote.proxy.rlwy.net` | **Dead** — connection reset |
| New Railway project `dayfi-api` | **Live** — API + Postgres provisioned |
| New API URL | `https://dayfi-api-production.up.railway.app/api/v1` |
| `api.dayfi.co` | **Down** until new Hetzner + DNS cutover |

---

## 1. Railway (database + temporary API)

Already created via CLI:

```bash
cd dayfi_backend
railway link          # project: dayfi-api
./scripts/sync-env-to-railway.sh
railway up --service dayfi-api
railway domain --service dayfi-api   # → dayfi-api-production.up.railway.app
```

**Verify:**

```bash
curl -s https://dayfi-api-production.up.railway.app/api/v1/health
curl -s https://dayfi-api-production.up.railway.app/api/v1/health/ready
```

**Important:** Do **not** set `DAYFI_PORT` on Railway — the platform injects `PORT`; the app must listen on that value.

**Postgres public URL (for Hetzner VPS):**

1. Railway dashboard → project **dayfi-api** → **Postgres** service  
2. **Connect** → enable **Public networking**  
3. Copy the **public** URL (`*.proxy.rlwy.net` or `*.railway.app`)  
4. Put it in `deploy/.env` as `DAYFI_DATABASE_URL` (append `?sslmode=require` if needed)

---

## 2. Hetzner VPS (production API — static IP for FW / YC)

Old server `88.99.122.244` is gone. Provision a **new** VPS:

1. [Hetzner Cloud](https://console.hetzner.cloud/) → **Add server**
2. **CX23**, Ubuntu 24.04, Falkenstein or Helsinki
3. Note the new **public IPv4** (e.g. `NEW_IP`)

### DNS

| Type | Name | Value |
|------|------|--------|
| A | `api` | **NEW_IP** |

Wait for DNS before TLS (Caddy / Let's Encrypt).

### VPS bootstrap

```bash
ssh root@NEW_IP
apt update && apt install -y git docker.io docker-compose-v2
usermod -aG docker $USER   # re-login

git clone <repo-url> dayfi_backend && cd dayfi_backend
cp deploy/.env.example deploy/.env
nano deploy/.env   # paste Railway Postgres PUBLIC URL + all secrets
```

Set in `deploy/.env`:

```bash
DAYFI_APP_URL=https://api.dayfi.co
DAYFI_SMILE_CALLBACK_URL=https://api.dayfi.co/api/v1/kyc/smile/webhook
```

Deploy:

```bash
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
curl -s https://api.dayfi.co/api/v1/health/ready
```

### Redeploy from Mac

```bash
export VPS_HOST=root@NEW_IP
./scripts/deploy-vps.sh
```

### Whitelist egress IP

```bash
npm run egress-ip   # on VPS with deploy/.env loaded
```

Add that IPv4 to **Flutterwave** and **Yellow Card** dashboards.

---

## 3. Mobile app (until `api.dayfi.co` is back)

**Temporary — Railway API** (auth/signup; FW/YC may fail on dynamic IP):

```bash
flutter run --flavor pilot --dart-define=FLAVOR=pilot \
  --dart-define=DAYFI_API_BASE_URL=https://dayfi-api-production.up.railway.app/api/v1
```

Or VS Code: **Flutter Dev (Railway API)**.

**After Hetzner cutover** — pilot/prod flavors use `https://api.dayfi.co/api/v1` again (no dart-define needed).

---

## 4. Cutover checklist

- [ ] `curl https://api.dayfi.co/api/v1/health/ready` → `database: up`
- [ ] `npm run fw:smoke` and `npm run yc:smoke` on VPS
- [ ] Webhooks point to `https://api.dayfi.co/api/v1/...`
- [ ] Flutter app tested (signup, send, banks list)
- [ ] Stop Railway **API** service (keep **Postgres** only)
