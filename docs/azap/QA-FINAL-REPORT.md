# Azap QA Final Report — FULL PASS blockers (live)

**Date:** 2026-09-05  
**Environment:** Production VPS `api.dayfi.co` + Stellar Testnet + live Flutterwave/YC APIs  
**CEO WhatsApp:** `+2348131208415`  
**Meta Flows:** Still **139000** (App Review in progress) — not blocking conversational money paths.

---

## Verdict on the four blockers you listed

| Blocker | Status now | Evidence |
|---------|------------|----------|
| `test:four-engine` | **PASS** | Docker up; **14/14** green |
| FLW bill pay (each category) | **BLOCKED externally** | Flutterwave merchant **NGN available_balance = 0** (rechecked 2026-09-05). Catalog + Azap PAY_BILL path live; settle fails until float funded. |
| YC GHS/KES/ZAR on WhatsApp | **WIRED (LIVE adapter)** | `SEND_YC` → channels → quote → PIN. |
| Full 14yo journey on WhatsApp | **PARTIAL PASS** | Chat + CTA PIN work. Native Flows blocked Meta. Create-wallet blank wait **fixed** (immediate ack + typing pulse). |

**Overall: NOT FULL PASS** — need FLW merchant NGN float + Meta Flow approval for native sheets. Conversational pipeline is the go-live path while waiting.

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
