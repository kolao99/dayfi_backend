# Azap QA Final Report — FULL PASS blockers (live)

**Date:** 2026-09-04  
**Environment:** Production VPS `api.dayfi.co` + Stellar Testnet + live Flutterwave/YC APIs  
**CEO WhatsApp:** `+2348131208415` (`DAYFI-986738`)

---

## Verdict on the four blockers you listed

| Blocker | Status now | Evidence |
|---------|------------|----------|
| `test:four-engine` | **PASS** | Docker up; **14/14** green |
| FLW bill pay (each category) | **BLOCKED externally** | Ran live on VPS. Flutterwave merchant wallet **NGN available_balance = 0** → every VAS pay returns *Insufficient funds in your wallet* (FLW merchant, not user). Catalog works (5 categories, airtime billers OK). |
| YC GHS/KES/ZAR on WhatsApp | **WIRED (LIVE adapter)** | `SEND_YC` → Yellow Card channels/networks → quote → PIN. KES bank channel **active**; GH bank often **inactive** on YC (honest message). Deployed. |
| Full 14yo journey on WhatsApp | **PARTIAL PASS** | Drove Meta path `routeWhatsappText` for CEO phone (Hey, balance, naira, fund, KES send, tx, swap). Replies pushed to WhatsApp. Live bill **money** failed only because FLW merchant float is empty. |

**Overall: NOT FULL PASS** — Azap code paths for these features are live on WhatsApp; **Flutterwave merchant NGN float must be funded** before bill money can succeed.

---

## What we ran on WhatsApp (CEO)

Script: `scripts/whatsapp-ceo-14yo-e2e.cjs` inside `deploy-api-1`

```
Hey
What's my balance?
How much do I have in naira?
How can someone send me money?
Fund my wallet
Send Kola KES 2000
show my transactions
swap 10 USDC to EURC
```

Then PIN-authorized bill attempts for AIRTIME / MOBILEDATA / UTILITYBILLS / INTSERVICE / CABLEBILLS → all failed with FLW merchant insufficient funds (confirmed via `/v3/balances`).

---

## What you must do for FULL PASS

1. **Fund the Flutterwave merchant NGN wallet** (Dayfi FLW dashboard) so VAS can settle.  
2. Re-run:  
   `docker exec deploy-api-1 node /app/scripts/whatsapp-ceo-14yo-e2e.cjs`  
3. Optionally complete a KES send with a real Kenyan bank account after bank pick + PIN.

Until (1), no amount of Azap code can make live Nigerian bill payments succeed.

---

## Suites (this machine)

| Suite | Result |
|-------|--------|
| `test:four-engine` | 14/14 PASS |
| Teen journey engine A–E | 7/7 PASS |
| `test:azap` | 41 PASS |

---

## Code shipped for these blockers

- YC conversational send: `yellowCardSendFlow.ts`, intent `SEND_YC`, authorize path  
- CEO WhatsApp E2E driver: `scripts/whatsapp-ceo-14yo-e2e.cjs`  
- Authorize now surfaces real provider error text (not only generic transfer_failed)  
- Deployed to `api.dayfi.co`
