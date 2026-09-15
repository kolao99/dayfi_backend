# Azap Money — Nigeria Launch Readiness

Date: 2026-09-15  
Product framing: **Azap Money** (conversational money + payments + bills + USDC/EURC) — **not** a crypto exchange.  
Geography: **Nigeria first.** Multi-country rails stay abstracted; do not block launch on 20 markets.

```text
Azap
 ├── Money — balance, send NGN, receive NGN, bank transfers, bills
 └── Crypto — USDC, EURC (DayFi custody + ledger)
```

## Architecture (honest)

```text
                 AZAP
                   │
             DayFi Ledger  ← source of truth for customer balances
              /          \
           NGN            USDC/EURC
            │                │
       Flutterwave       DayFi custody
            │                │
        Nigerian         Master / operational wallets
        bank rails       + per-user entitlement on ledger
```

| Claim | Truth |
|-------|-------|
| Custodial USDC/EURC | **Yes** — master/treasury wallets + DayFi ledger. Do **not** call this non-custodial. |
| YC NGN→external-wallet buy | **Future** — blocked until live account entitlement (`CRYPTO-TRADE-GATE.md`). **Not a launch blocker.** |
| Flutterwave NGN collect/payout | **Launch rail** for Nigeria money. |

“Buy ₦50k USDC” on launch = **fund DayFi wallet** (NGN VA → USDC ledger credit, or on-chain deposit) — not a CEX order and not YC direct settlement.

---

## GO criteria (PM gate moved here)

### NGN

| Check | Target | Status (code audit) |
|-------|--------|---------------------|
| Flutterwave collection (VA) | Credits ledger; webhook idempotent | **PARTIAL** — path LIVE; mainnet E2E still PARTIAL |
| Flutterwave NGN payout | Bank send succeeds; failures safe | **PARTIAL** — sync fail reverses; **async fail may not re-credit** |
| Ledger ↔ FLW reconcile | Ops can match deposits | **PARTIAL** — `reconcile-flutterwave-deposits.ts` exists |
| Duplicate webhook protection | No double credit | **GO** on deposit path |
| Bills settle | Electricity/airtime/etc. pay | **NO-GO ops** — FLW merchant NGN float = 0 historically |
| Transaction history | User can see recent activity | **PARTIAL** — basic list; thin status UX |

### USDC/EURC (custodial)

| Check | Target | Status (code audit) |
|-------|--------|---------------------|
| Wallet provisioning | Stellar USDC/EURC addresses + trustlines | **GO** (code); master XLM liquidity can block provision |
| Deposits | On-chain → ledger credit | **GO** (testnet PASS in matrix) |
| Ledger-backed balances | User balance = ledger entitlement | **GO** |
| Sends | Custodial outbound + ledger debit | **GO** (code) / **PARTIAL** mainnet E2E |
| Confirmation + idempotency | No double spend / double credit | **PARTIAL** |
| Treasury reconcile | Σ user USDC ≈ custody wallets | **PARTIAL** — tooling incomplete for full consumer treasury console |

### Azap conversation

| Check | Target | Status |
|-------|--------|--------|
| Balance / send NGN / bills / crypto receive-send | Natural language → FSMs | **GO** intents; bills settle blocked on float |
| PIN isolated | No PIN in chat; browser secure URL | **GO** |
| KYC enforced | Send gated | **GO** |
| No fake success | Scrub + receipts only after providers | **GO** |
| Secure browser → WhatsApp return | Clean handoff | **GO** |

### Operations (hard gate)

```text
DayFi ledger: users collectively own X USDC
Custody wallets: hold ≈ X USDC
```

Must be reconcilable before calling launch **GO**. Same for NGN/FLW deposit/payout integrity.

---

## Verdict

| Question | Answer |
|----------|--------|
| Wait for YC crypto entitlement to launch? | **No** |
| Launch as non-custodial / YC direct-to-wallet? | **No** — do not blur |
| Launch as Azap Money (NG + FLW + custodial USDC/EURC)? | **Yes, when GO criteria above are green** |
| Current overall | **PARTIAL** — not full GO until bills float, async payout safety, and custody↔ledger reconcile are proven |

### Immediate launch blockers

1. Fund Flutterwave merchant NGN float (bills).  
2. Fix or verify async FLW payout failure → ledger re-credit.  
3. Prove mainnet reconcile: ledger vs FLW vs crypto custody.  
4. Confirm master wallet liquidity for Stellar provisioning.

### Explicitly deferred (not launch blockers)

- YC Convert / Direct Settlement crypto buy  
- Ghana / Kenya / … country rails (keep `PaymentRail` abstraction)  
- BTC / ETH / SOL user exposure  

See also: `CRYPTO-TRADE-GATE.md` (YC future rail), `PM-GATE-VERIFICATION.md` (conversation safety), `qa-capability-matrix.md`.
