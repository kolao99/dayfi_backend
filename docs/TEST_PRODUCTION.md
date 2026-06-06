# Test production API (api.dayfi.co)

## 1. API health (Mac)

```bash
curl -s https://api.dayfi.co/api/v1/health
curl -s https://api.dayfi.co/api/v1/health/ready
```

## 2. Provider smoke tests (run on VPS — uses whitelisted egress IP)

```bash
ssh root@88.99.122.244
cd /root/dayfi_backend
# One-time if node_modules missing on host:
# apt install -y nodejs npm && npm ci

set -a
source deploy/.env
set +a

npm run egress-ip
npm run fw:smoke
npm run yc:smoke
# or: npm run smoke:providers
```

**Flutterwave OK:** `OK: N Nigerian banks`  
**Yellow Card OK:** JSON channels/rates (no IP whitelist 401)

**After fixing `/payments/channels`:** redeploy API on VPS, then in the app go back to Send and re-open (channels cache ~5 min). ZA bank should use a real Yellow Card `id`, not a greyed-out fallback row.

## 3. Mobile app

VS Code → **Run and Debug**:

| Config | API |
|--------|-----|
| **Flutter Dev (api.dayfi.co)** | Hetzner prod (test FW/YC from app) |
| **Flutter Pilot / Prod** | `https://api.dayfi.co/api/v1` (built into `flavors.dart`) |

**In-app checks after login:**

1. Home / wallet loads  
2. **Send** → Nigerian banks list (Flutterwave)  
3. **Pay bills** → categories load; pay shows **MTN Airtime** (or similar) in History, not “Bill payment”  
4. **History** → NGN deposit subtitle says “received”; bill refund is separate from deposit  
5. **Notifications** bell badge updates after deposit/send/bill/P2P  
6. **DayBudget** → new user sees empty plan (no stale data from another account on same device)  
7. Cross-border / YC send path (Yellow Card)

## 4. After tests pass

- Webhooks → `https://api.dayfi.co/api/v1/...`  
- Stop Railway **API**; keep Postgres  
- Whitelist `88.99.122.244` at Flutterwave + Yellow Card if not done
