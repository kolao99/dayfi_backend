# Azap CEO E2E test matrix

**Product under test:** one conversational wallet (WhatsApp → Azap → Dayfi).  
**Canonical balance:** USDC (Dayfi USD ledger).  
**Local currencies (NGN, GHS, KES, …):** money rails + display/valuation — **not** 19 separate wallets.

**Environment:** Stellar Testnet + Flutterwave / Dayfi sandbox only. **No Mainnet.**

**CEO PASS rule:** every LIVE row below must complete `request → quote/requirements → (KYC) → confirm → PIN (if money out) → provider → webhook/status → ledger → user-visible balance/status` with authoritative amounts only. Fake success = FAIL.

---

## Mental model (six jobs)

| User wants to… | What Azap should understand | Not this |
| --- | --- | --- |
| **Fund / add money** | Put value into the USDC wallet (fiat ramp or crypto deposit) | Opening a separate NGN/GHS wallet |
| **Send money** | Pay someone in the currency they named; debit USDC equivalent | Forcing the user to pre-convert |
| **Pay bills** | Purchase a local service (airtime/data/utility/TV) from wallet value | “Send money to another user” |
| **Receive money** | Show crypto address and/or local receiving rail (e.g. NGN VA) | Inventing unsupported corridors |
| **View balance** | Canonical USDC, or **valuation** in another currency | Inventing a held NGN/GHS balance |
| **Crypto move** | Actual USDC/EURC on-chain send/deposit | CEX buy/sell/swap unless mapped below |

### Buy / sell / swap (explicit)

| Phrase | Product meaning | Test as |
| --- | --- | --- |
| “Buy USDC” / “Fund with ₦50k” | Fiat → USDC wallet **funding/ramp** | FUND |
| “Sell USDC” / “Cash out” | USDC → local fiat **payout/off-ramp** | SEND |
| “Swap USDC↔EURC” / “Convert to EURC” | True asset conversion | **BLOCKED** — refuse honestly; never call `POST /payments/wallets/swap` (410) |

There is **no CEX order-book API**. That does **not** mean Azap cannot move value — funding and off-ramp reuse Dayfi rails.

---

## Corridor / rail truth table

African corridors in Dayfi Collect (`infraCorridors.ts`, ~19 countries) are **one catalog of rails**, not separate wallet products.

| Rail | Fund into USDC | Send / off-ramp | Receive instructions | Azap today |
| --- | --- | --- | --- | --- |
| NGN (Flutterwave VA / bank send) | Yes | Yes | NGN VA / bank details | **LIVE** (partial E2E) |
| USDC crypto (Stellar / ETH / BSC / Arb) | Yes (deposit) | Yes (crypto send) | Deposit address | **LIVE** (Testnet deposit E2E PASS) |
| EURC crypto (Stellar / ETH) | Deposit | Crypto send | Deposit address | LIVE / PARTIAL |
| GHS / KES / ZAR / … (Yellow Card) | Dayfi HTTP / Collect | Dayfi HTTP send | Corridor-dependent | **HTTP only** — not yet Azap conversational |
| Grey USD VA | Dayfi HTTP | — | USD VA | **HTTP only** |

**QA rule:** For GHS/KES/… phrases, either complete the full Dayfi corridor path **or** Azap must say the corridor is not available on WhatsApp yet — never fake a quote or success.

---

## A. FUND

Complete chain per supported rail:

`request → requirements/KYC → payment instructions → user pays → webhook/sync → USDC credit → ledger → “What’s my balance?”`

| # | Utterance | Expected | Status |
| --- | --- | --- | --- |
| F1 | Fund my wallet | Choice: bank vs crypto | LIVE |
| F2 | Fund with crypto | Asset/network → address | LIVE |
| F3 | Give me my USDC address | Address + network | LIVE |
| F4 | Fund with ₦50,000 / Buy USDC / Add ₦50k | NGN → USDC ramp (VA) | LIVE / PARTIAL |
| F5 | Fund with GHS 500 | Honest unavailable on WhatsApp (YC in app) | **HONEST REFUSE** |
| F6 | Fund with KES 2,000 | Same | **HONEST REFUSE** |
| F7 | Fund with EURC | EURC deposit flow | PARTIAL |
| F8 | Fund with 50 USDC | Crypto deposit (USDC→USDC) | LIVE |

**Break tests:** cancel mid-flow; ask balance during `AWAITING_DEPOSIT` without killing address; unsupported network (Solana) refused.

---

## B. RECEIVE

| # | Utterance | Expected | Status |
| --- | --- | --- | --- |
| R1 | How can someone send me money? | Explain crypto + local rails that exist | PARTIAL |
| R2 | Give me my USDC address | Same as F3 | LIVE |
| R3 | What’s my NGN account? / Give me my bank details | Flutterwave VA (KYC/BVN as required) | LIVE / PARTIAL |
| R4 | Did the money arrive? | Provider/ledger status — never invent | LIVE (crypto); PARTIAL (NGN) |

---

## C. BALANCE / VALUATION

Valuation is **not** a conversion transaction.

| # | Utterance | Expected | Status |
| --- | --- | --- | --- |
| B1 | What’s my balance? / How much do I have? | Canonical **USDC** | LIVE |
| B2 | How much do I have in naira? | Estimated NGN + “underlying USDC” | LIVE (FX) |
| B3 | How much is that in cedis? / Show balance in GHS | Estimated GHS + underlying USDC | LIVE (if rate configured) |
| B4 | How much USDC do I need to send ₦10,000? | Quote from Dayfi FX + fee | LIVE (unit) |
| B5 | Show my EURC balance (if none held) | Do not invent EURC holdings | Must refuse / show zero honestly |

---

## D. SEND

Chain:

`recipient → currency → amount → rate → fee → balance check → confirmation → PIN → Dayfi/provider → status → ledger`

| # | Utterance | Expected | Status |
| --- | --- | --- | --- |
| S1 | Send Kola ₦5,000 | NGN payout; debit USDC equivalent | LIVE / PARTIAL |
| S2 | Send Kola 10 USDC | Crypto send | LIVE / PARTIAL |
| S3 | Send Kola GHS 500 | Honest unavailable (YC in Dayfi app) | **HONEST REFUSE** |
| S4 | Send Kola KES 2,000 | Same | **HONEST REFUSE** |
| S5 | Sell USDC / Cash out to bank | Off-ramp language → send prompt | LIVE (NL → send) |
| S6 | Did my ₦5,000 transfer go through? | Authoritative status | PARTIAL |

**Break tests:** insufficient USDC; wrong NUBAN; cancel before PIN; prompt-injection cannot skip PIN.

---

## E. BILLS (local service purchase — not P2P send)

Same Dayfi consumer path as SendHome (`BillsService` / Flutterwave VAS).

Per category: `discover → validate → select → amount → balance → confirmation → PIN → provider → status → ledger`

| # | Utterance / category | Status |
| --- | --- | --- |
| P1 | Buy airtime / Buy ₦1,000 airtime | WIRED — **FLW sandbox E2E pending** |
| P2 | Buy data / Buy 5GB MTN data | WIRED — E2E pending |
| P3 | Pay electricity / Pay my light | WIRED — E2E pending |
| P4 | Pay internet | WIRED — E2E pending |
| P5 | Pay DSTV / Pay GOtv | WIRED — E2E pending |

**Break tests:** invalid meter/smartcard; cancel; switch to send mid-bill without corrupting PIN gate.

---

## F. Cross-cutting / chaos

| # | Scenario | Expected |
| --- | --- | --- |
| X1 | Interrupt deposit with “hi” / balance | Deposit context preserved or recoverable |
| X2 | Cancel | Clear active intent; no money moved |
| X3 | Swap / convert USDC to EURC | Honest unavailable |
| X4 | Show my transactions | Authoritative list or honest partial |
| X5 | Repeat Fund → Receive → Balance → Send → Bills | No double-credit; ledger matches chat |

---

## CEO PASS checklist (gate)

Do **not** declare final CEO PASS until:

1. [ ] `npm run db:up && npm run test:four-engine` green  
2. [ ] FUND F2–F4 + F8: webhook/sync → USDC credit → balance (Testnet / FLW sandbox)  
3. [ ] SEND S1 + S2: PIN → provider success/fail → ledger  
4. [ ] BILLS P1–P5: at least one live Flutterwave sandbox success **per category** (or documented sandbox limitation)  
5. [ ] BALANCE B1–B3: valuation never presented as a held local wallet  
6. [ ] Non-LIVE corridors (GHS/KES fund/send): honest “not on WhatsApp yet” — no fake quotes  
7. [ ] Swap refused; no call to 410 `/wallets/swap`

**Current overall:** **NOT FULL PASS** until Flutterwave merchant NGN float is funded and live VAS pays succeed. Engine + YC WhatsApp adapter + WhatsApp conversation path are live.

---

## Related docs

- [`qa-capability-matrix.md`](./qa-capability-matrix.md) — capability × provider status  
- [`QA-FINAL-REPORT.md`](./QA-FINAL-REPORT.md) — run results  
- [`p1-money-movement.md`](./p1-money-movement.md) — engineering notes  
