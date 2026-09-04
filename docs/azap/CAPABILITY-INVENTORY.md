# Azap capability inventory (from code — not from marketing)

**Sources:** Dayfi `payment/*`, `four/*`, `azap/*`, SendHome Flutter services, `infraCorridors.ts`, `cryptoNetworks.ts`, `billsService.ts`.  
**Rule:** Azap must expose existing consumer services conversationally. Do not invent replacements. Do not use `infraBillsService` for end users.

Canonical wallet: **USD / USDC ledger**. Local currencies = rails + valuations.

---

## Legend (Azap adapter)

| Status | Meaning |
|--------|---------|
| LIVE | Conversational path executes Dayfi consumer service |
| WIRE | Partial (NL or slash only; incomplete rail) |
| HTTP | Dayfi/SendHome API exists; Azap chat not wired |
| BLOCKED | Must refuse (dead endpoint / disabled) |
| INFRA | Org/Collect only — not Azap end-user |

---

## Funding / receive

| Capability | Dayfi | SendHome | Provider | Azap |
|------------|-------|----------|----------|------|
| NGN Flutterwave VA | `POST /wallets/add/fiat/ngn`, `ensureNgnVirtualAccount` | Add money → Bank | Flutterwave | **LIVE** (`beginNgnBankFunding`, bank_details NL) |
| Crypto deposit USDC/EURC | `wallet-provision`, `receive/crypto`, inflow sync | Receive crypto (add-money crypto gated off flavor) | Stellar/EVM | **LIVE** (`FUND_CRYPTO`) |
| Grey USD/EUR/GBP VA | `GET /grey/accounts`, `/receive/us-bank` | Wallet receive | Grey | **HTTP** |
| YC Africa collection | `POST /create-collections` | Deposit channels | Yellow Card | **HTTP** |
| Card charge | `charge-card*` | Legacy | Flutterwave | **HTTP** (not Azap P1) |

Azap allowlist networks: `stellar`, `ethereum`, `bsc`, `arbitrum` (Mantle/Sonic/XDC config-only, not advertised).

---

## Sending / off-ramp

| Capability | Dayfi | SendHome | Provider | Azap |
|------------|-------|----------|----------|------|
| NGN bank transfer | `POST /bank-transfer` | DayX / bank path | Flutterwave | **LIVE** (`SEND_MONEY`) |
| YC African corridors (~19) | `POST /send/yellowcard` + limits | Full send UI | Yellow Card | **HTTP** — chat returns honest unavailable |
| Dayfi Tag P2P | `initiate-wallet-transfer` | Dayfi Tag flow | Internal | **HTTP** |
| Crypto send USDC/EURC | `POST /crypto/send` | Crypto send UI | Stellar/EVM | **LIVE** (`SEND_CRYPTO`) |
| Sell USDC language | — | Cash out UI | — | **WIRE** → send/off-ramp prompt |

Corridors (YC catalog): NG, BJ, BW, BF, CM, CG, CD, CI, GA, MW, ML, RW, SN, ZA, KE, GH, TZ, TG, UG, ZM — see `infraCorridors.ts`.

---

## Bills (consumer only)

| Category | Code | Dayfi | SendHome | Azap |
|----------|------|-------|----------|------|
| Airtime | AIRTIME | `BillsService.payBill` | Yes | **LIVE** `PAY_BILL` |
| Data | MOBILEDATA | same | Yes | **LIVE** |
| Electricity | UTILITYBILLS | same | Yes | **LIVE** |
| Internet | INTSERVICE | same | Yes | **LIVE** |
| TV/Cable (DSTV/GOtv/…) | CABLEBILLS | same | Yes | **LIVE** |

Path: WhatsApp → Azap → PAY_BILL → PIN → `billsService` → Flutterwave VAS → ledger.  
**Not** `infraBillsService`.

Provider E2E (sandbox money movement): **not yet executed** on this runner — see QA report.

---

## Balance / FX / history

| Capability | Dayfi | Azap |
|------------|-------|------|
| Canonical balance | USD ledger | **LIVE** USDC wording |
| Valuation NGN/GHS/… | `fxService` + `exchange_rates` | **LIVE** |
| Send cost quote | FX convert | **LIVE** |
| Public/YC rates | `/api/public/rates`, `/payments/rates` | **WIRE** (registry `/rates` not engine) |
| Tx history | `GET /wallet-transactions` | **WIRE** (recent SQL via `walletIntel`) |
| Swap / convert wallets | `POST /wallets/swap` → **410** | **BLOCKED** |

---

## KYC / PIN / security

| Capability | Dayfi | Azap |
|------------|-------|------|
| BVN / Smile KYC | `/kyc/*`, Four verify-bvn | **LIVE** |
| Setup PIN | Four security + Flows | **LIVE** |
| Authorize PIN | `POST /four/intents/:id/authorize` | **LIVE** for SEND_MONEY, SEND_CRYPTO, PAY_BILL |
| Change PIN | Auth routes | **MISSING** chat |

---

## Webhooks

| Provider | Endpoint | Azap push |
|----------|----------|-----------|
| Flutterwave deposit | `POST /payments/webhooks/flutterwave` | Yes (NGN arrived) |
| Flutterwave transfer (legacy) | `POST /payments/webhook` | Partial |
| Yellow Card | `POST /payments/yc-webhook` | Consumer path; Azap not driving YC sends |
| Grey | `POST /payments/grey/webhook` | No Azap push wired |
| Stellar inflow | sync job / horizon | Yes (deposit arrived) |
| Smile KYC | `/kyc/smile/webhook` | — |

---

## Explicitly out of Azap end-user scope

- Infra org Collect / treasury / bulk / org bills  
- Investment / DayEarn / Budgets (SendHome code exists; not Azap money LIVE)  
- Advertising “all African countries” on WhatsApp until YC adapter is LIVE  

---

## Adapter priority (to reach CEO FULL PASS)

1. Flutterwave sandbox bill E2E per category + engine DB suite  
2. YC send conversational adapter (reuse `walletFundedYellowCardSend`)  
3. Richer tx status (“did Kola receive it?” → named transfer lookup)  
4. Grey receive instructions (optional)  
5. Multi-action partial-success messaging for ActionPlan  

Inventory date: 2026-09-04.
