# Azap Crypto Engine — Rails & Doctrine

Date: 2026-09-15  
Status: **Two crypto rails. Launch uses custodial DayFi. YC is future liquidity.**

## Product framing

Launch as **Azap Money**, not a crypto exchange. Nigeria first:

| Rail | Role now | Role later |
|------|----------|------------|
| **DayFi custody + ledger** | USDC/EURC receive, hold, send; “buy USDC” = fund wallet | Treasury / liquidity ops |
| **Flutterwave** | NGN collect + NGN payout | — |
| **Yellow Card** | Fiat corridors where live; **crypto direct settlement NO-GO** on this account | Non-custodial / entitled buy-sell when `discoveredPairs` non-empty |

**Do not call DayFi USDC/EURC non-custodial.** Master/operational wallets + ledger entitlements = custodial.

## Crypto engine (multi-asset)

```text
                    CRYPTO ENGINE
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
        USDC            EURC           BTC / ETH / SOL / …
          │              │              │
          └──────────────┼──────────────┘
                         ↓
                  ensureWallet(strategy)
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
     Custodial DayFi path      YC adapter (when entitled)
     (launch: USDC/EURC)       (future: buy/sell settlement)
              ↓                     ↓
           DayFi Ledger ←───────────┘
                         ↓
                       Azap
```

BTC/ETH/SOL stay in catalog and share architecture. **User-hidden** until wallet strategy + live YC (or chosen custody) + E2E pass. Never hardcode “impossible.”

## Live YC probe (VPS `169.58.199.93`)

| Surface | Result |
|---------|--------|
| Channels / networks | Fiat only — no crypto pairs |
| discoveredPairs | **[]** |
| User-facing YC crypto buy/sell | **NO-GO** |

This does **not** block Azap Money launch. See `LAUNCH-READINESS.md`.

## Catalog matrix

| Asset / Network | Catalog | Wallet strategy | Launch user path | YC trade |
|-----------------|---------|-----------------|------------------|----------|
| USDC / Stellar | yes | `stellar_dayfi` | Fund / deposit / send (custodial) | hidden |
| EURC / Stellar | yes | `stellar_dayfi` | Fund / deposit / send (custodial) | hidden |
| USDC / Ethereum | yes | `evm_dayfi` | Deposit/send where enabled | hidden |
| ETH / Ethereum | yes | `evm_dayfi` | gated | hidden |
| BTC / Bitcoin | yes | `bitcoin_pending` | gated | hidden |
| SOL / Solana | yes | `solana_pending` | gated | hidden |

## Code map

| Piece | Path |
|-------|------|
| Catalog + effective caps | `azap/crypto/assetRegistry.ts` |
| Strategies + ensureWallet | `payment/ensureWallet.ts` |
| YC discovery | `payment/yellowCardCapabilityService.ts` |
| YC trade gate | `payment/cryptoTradeGate.ts` |
| Facade | `payment/cryptoEngine.ts` |
| Azap buy/sell dispatch | `four/engine/conversationEngine.ts` — USDC/EURC → fund/send; other assets → YC gate |

## Roadmap

```text
NOW — Nigeria · Flutterwave · custodial USDC/EURC · bills
  ↓
YC crypto entitled
  ↓
Optional non-custodial / direct-settlement buy-sell
  ↓
Ghana · Kenya · …
  ↓
BTC / ETH / SOL when wallet + entitlement + E2E ready
```
