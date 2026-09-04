# Azap QA Capability Matrix

**Generated from repository audit (Dayfi backend + SendHome + dayfi-infra).**  
**Environment for this mission: Testnet / Flutterwave sandbox only — no Mainnet.**

Legend — Azap status:

| Status | Meaning |
|--------|---------|
| LIVE | End-to-end through Azap → Dayfi → provider |
| WIRE | Dayfi/SendHome exists; Azap adapter in progress / just wired |
| HTTP | Dayfi HTTP exists; Azap does not call yet |
| BLOCKED | No Dayfi product API (do not advertise) |

---

## Product model (canonical wallet)

**USDC (Dayfi USD ledger) is the underlying wallet balance.**  
NGN / GHS / KES / ZAR / etc. are **display and interaction currencies** (valuations + fiat send/fund rails) — not separate fake held balances.

| User says | Meaning |
|-----------|---------|
| What's my balance? | Canonical USDC |
| How much in naira / cedis? | FX valuation via `exchange_rates` (display only) |
| Fund / buy USDC / add ₦50k | Fiat ramp or crypto deposit → credit USDC |
| Sell / cash out USDC | Off-ramp → NGN (or supported) send |
| Send Kola ₦5,000 | Quote USDC cost → debit USDC → NGN payout |
| Convert / swap USDC↔EURC | Real asset conversion — **unavailable** (old swap HTTP 410); do not fake |

## Funding

| Capability | Provider | Dayfi service | Azap entry | KYC | PIN | Currencies / networks | Fees / limits | Async | Webhook | Azap status | Test status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NGN bank receive (VA) | Flutterwave | `PaymentService.ensureNgnVirtualAccount` · `beginNgnBankFunding` · FLW deposit webhook | Fund → Bank / “give me my account” / “add ₦50k” / “buy USDC” | BVN required | No | NGN → USDC credit | FLW VA rules | Yes | `POST /payments/webhooks/flutterwave` | LIVE | PARTIAL |
| NGN mobile money receive | Yellow Card | Infra/YC corridors; consumer Azap uses FLW VA for NG | — | — | — | NG MoMo listed in YC corridors | YC | Yes | YC webhook | HTTP | NOT STARTED |
| Crypto deposit USDC | Stellar / EVM | `cryptoWalletProvision` · `syncStellarInflowsToLedger` / EVM sync | FUND_CRYPTO | No for crypto | No | USDC: Stellar, ETH, BSC, Arbitrum (Azap allowlist) | Network fees display | Yes | Sync + push | LIVE | PASS (Testnet E2E) |
| Crypto deposit EURC | Stellar / ETH | same | FUND_CRYPTO | No | No | EURC: Stellar, Ethereum | — | Yes | Sync | LIVE | PARTIAL |
| Grey USD VA | Grey | `greyService.ensureVirtualAccount` | — | — | — | USD | Grey | Yes | Grey webhook | HTTP | NOT STARTED |

## Sending money

| Capability | Provider | Dayfi service | Azap entry | KYC | PIN | Notes | Azap status | Test status |
|---|---|---|---|---|---|---|---|---|
| NGN bank transfer | Flutterwave | `PaymentService.bankTransfer` · `executeBankSend` | SEND_MONEY / “Send Kola ₦5k” / “sell USDC” → send | Yes | Yes | Debits USDC equivalent; recipient gets NGN | LIVE | PARTIAL |
| African corridors (YC) | Yellow Card | `POST /payments/send/yellowcard` | — | Yes | App PIN | SendHome path | HTTP | NOT STARTED |
| Crypto send USDC/EURC | Stellar / EVM | `cryptoSendService` · `continueCryptoSend` | SEND_CRYPTO | No | Yes | Address validation | LIVE | PARTIAL |
| Saved recipients | Dayfi DB | `savedRecipientService` | Name resolve | — | — | Soft match | LIVE | PARTIAL |
| Send cost quote | Dayfi FX | `buildSendCostQuoteReply` · `fxService` | “How much USDC to send ₦10k?” | No | No | Authoritative rates only | LIVE | UNIT |

## Balance / valuation

| Capability | Dayfi | Azap | Status |
|---|---|---|---|
| Canonical balance | USD ledger (`usdLedgerBalance`) | “What's my balance?” → USDC | LIVE |
| NGN / GHS / … equivalent | `convertAmountBetween` + `exchange_rates` | “How much in naira/cedis?” | LIVE |
| Fake local-currency wallet | — | **Must not invent** | N/A |

## Asset conversion (true swap)

| Capability | Provider | Dayfi service | Azap status | Notes |
|---|---|---|---|---|
| Buy USDC (CEX) | — | N/A | **Mapped to FUND** | Fiat/crypto funding, not exchange order book |
| Sell USDC (CEX) | — | N/A | **Mapped to SEND / off-ramp** | NGN payout from USDC balance |
| Swap USDC↔EURC | — | `POST /payments/wallets/swap` → **410 Gone**; no alternate conversion API found | BLOCKED | Honest refusal; do not call dead endpoint |
| Ledger FX multi-wallet (legacy) | Dayfi | `swapCurrency` still in services but product is single global USD | Not exposed | Do not re-advertise multi-wallet swap |

## Bills (Flutterwave VAS — same as SendHome)

| Category | Code | Dayfi | SendHome | Azap entry | KYC | PIN | Validate | Azap status | Test status |
|---|---|---|---|---|---|---|---|---|---|
| Airtime | AIRTIME | `BillsService.payBill` | Yes | PAY_BILL | Soft | Yes | Skip | WIRE → LIVE | IN PROGRESS |
| Data | MOBILEDATA | same | Yes | PAY_BILL | Soft | Yes | Skip | WIRE | IN PROGRESS |
| Electricity | UTILITYBILLS | same | Yes | PAY_BILL | Soft | Yes | Required | WIRE | IN PROGRESS |
| Internet | INTSERVICE | same | Yes | PAY_BILL | Soft | Yes | Required | WIRE | IN PROGRESS |
| TV / Cable | CABLEBILLS | same | Yes | PAY_BILL | Soft | Yes | Required | WIRE | IN PROGRESS |

HTTP: `GET/POST /payments/bills/*` · Infra twin exists for orgs (`infraBillsService`) — **Azap uses consumer `billsService` only.**

## Account / security

| Capability | Dayfi | Azap | Status | Test |
|---|---|---|---|---|
| Balance | Ledger wallets · `buildBalanceReply` | “What’s my balance?” | LIVE | PASS (zero vs fail distinguished) |
| Tx history | `GET /payments/wallet-transactions` | Partial (crypto deposit status) | PARTIAL | PARTIAL |
| KYC / BVN | `verifyBvnFromFour` · Smile | KYC mini-app | LIVE | PARTIAL |
| PIN setup / authorize | `pinSetupService` · `authorizeIntentWithPin` | WhatsApp secure UI | LIVE | PARTIAL |
| Deposit status | `checkCryptoDepositStatus` | “Did it arrive?” | LIVE | PASS (Testnet) |

## Explicitly NOT advertised / not faked

- Mantle / Sonic / XDC (unless Collect re-enables)
- True USDC↔EURC (or other) **asset swap** — refuse; never call 410 `/wallets/swap`
- Fake held NGN/GHS/KES wallet balances (valuation only)
- YC African fund/send success on WhatsApp until Azap adapter is LIVE
- Infra org Collect treasury addresses as user wallets

---

## CEO testing

**Full Fund → Receive → Balance → Send → Bills matrix:**  
[`CEO-E2E-TEST-MATRIX.md`](./CEO-E2E-TEST-MATRIX.md)

**Code inventory (Dayfi + SendHome → Azap):**  
[`CAPABILITY-INVENTORY.md`](./CAPABILITY-INVENTORY.md)

See [`QA-FINAL-REPORT.md`](./QA-FINAL-REPORT.md) — **NOT FULL PASS / CEO NOT READY** until matrix gates + provider E2E pass.
