# Dayfi money capabilities (from implementation)

Source of truth: running Dayfi dashboard Collect UI + backend code — **not** Azap prompts.

## Two different products

| Surface | What it is | Crypto destination |
|---|---|---|
| **Dashboard Collect** (`Payments.jsx`) | Merchant collection: customer pays org | Org treasury addresses (`DAYFI_INFRA_STELLAR_ADDRESS` / EVM master) via `createCollection` |
| **Consumer wallet** (`GET /payments/wallet-details`, `cryptoWalletProvision`) | User's Dayfi/Azap wallet | **Per-user** Stellar `G…` + EVM `0x…` on `wallets` |

Azap is a **consumer wallet** assistant. It must use provisioned user addresses, not Collect treasury addresses.

## Collect UI (dashboard)

Files:

- `dayfi-infra/web/src/pages/dashboard/Payments.jsx`
- `dayfi-infra/web/src/config/corridors.js` (fallback)
- `GET /api/infra/v1/reference/crypto-networks?asset=`
- `GET /api/infra/v1/corridors`
- `POST` create payment → `createCollection` in `infraMoneyService.ts`

Rails shown:

1. Provider / Fiat — bank or mobile money (Yellow Card corridors)
2. External Stellar wallet — on-chain USDC/EURC

API `listCryptoNetworks` lists: `stellar`, `ethereum`, `bsc`, `arbitrum`, `mantle`, `sonic`, `xdc` (from `CRYPTO_NETWORKS` with receive enabled).

## Crypto asset × network (deposit / withdraw)

From `dayfi_backend/src/config/cryptoNetworks.ts` **intersected with** Collect API filter.

| Asset | Network | Deposit (receive) | Withdraw (send) | Buy | Sell | Swap |
|---|---|---|---|---|---|---|
| USDC | Stellar | yes | yes | not via Azap | not via Azap | wallet swap exists in payments API; not wired to Azap |
| USDC | Ethereum | yes | yes | no | no | no |
| USDC | BNB Smart Chain | yes | yes | no | no | no |
| USDC | Arbitrum One | yes | yes | no | no | no |
| USDC | Mantle | yes | yes | no | no | no |
| USDC | Sonic | yes | yes | no | no | no |
| USDC | XDC | yes | yes | no | no | no |
| EURC | Stellar | yes | yes | no | no | no |
| EURC | Ethereum | yes | yes | no | no | no |
| EURC | BSC | no | no | — | — | — |
| EURC | Arbitrum | no | no | — | — | — |

Stellar consumer wallets are funded with **~1.5 XLM** on create/provision and open **USDC + EURC** trustlines (master-sponsored when `MASTER_WALLET_*` is set).

EVM L2s share the **same 0x deposit address** as Ethereum (`resolveDepositAddressForNetwork`).

**Memo:** consumer Stellar deposits use a unique address — **no memo required**. Org Collect funding may attach a memo internally; that is not the Azap user wallet flow.

## Fiat corridors (Yellow Card off-ramp list)

From `infraCorridors.ts` / dashboard `YELLOW_CARD_CORRIDORS` (same set). Live bank/momo **channel IDs** come from Yellow Card `listChannels()`; a corridor can be listed in UI but `live: false` if YC has no matching channel.

| Country | ISO | Ccy | Bank | MoMo |
|---|---|---|---|---|
| Nigeria | NG | NGN | yes | yes |
| South Africa | ZA | ZAR | yes | no |
| Kenya | KE | KES | yes | yes |
| Ghana | GH | GHS | yes | yes |
| Uganda | UG | UGX | yes | yes |
| Tanzania | TZ | TZS | yes | yes |
| Rwanda | RW | RWF | yes | no |
| Zambia | ZM | ZMW | yes | yes |
| Botswana | BW | BWP | yes | yes |
| Malawi | MW | MWK | yes | yes |
| Senegal | SN | XOF | no | yes |
| Cameroon | CM | XAF | no | yes |
| Côte d'Ivoire | CI | XOF | no | yes |
| DR Congo | CD | CDF | no | yes |
| Congo | CG | XAF | yes | no |
| Gabon | GA | XAF | yes | no |
| Benin | BJ | XOF | no | yes |
| Burkina Faso | BF | XOF | no | yes |
| Mali | ML | XOF | no | yes |
| Togo | TG | XOF | no | yes |

NGN consumer **add money** uses Flutterwave virtual accounts: `POST /payments/wallets/add/fiat/ngn`. Azap `beginNgnBankFunding` calls the same service after BVN + email checks.

## Providers

- **Yellow Card** — African bank/momo collect + payout
- **Flutterwave** — NGN name enquiry, virtual accounts, some payouts
- **Stellar Horizon** — user wallet provision, USDC/EURC trustlines, inflow sync
- **EVM** — per-user deposit address; send via `cryptoSendService`

## Consumer crypto deposit flow (Azap uses this)

1. User asks to fund with crypto / names asset+network
2. `provisionCryptoWalletsForUser` (idempotent) writes `stellar_deposit_address` + `ethereum_deposit_address`
3. Address returned immediately (custodial keys encrypted on `wallets`)
4. User sends on-chain
5. Stellar: `syncStellarInflowsToLedger` (triggered on wallet-details load) credits USD ledger
6. Shown in `wallet_transactions`

Azap does **not** poll for confirmation after sharing the address.

## Consumer crypto send / withdraw

`cryptoSendService` + PIN. Azap WhatsApp creates `SEND_CRYPTO`, user authorizes with the existing PIN sheet, then `authorizeIntentWithPin` calls `routeCryptoSend`.

## KYC / PIN / idempotency

- BVN KYC for NGN bank funding and local payouts
- Transaction PIN for send/authorize (`four` intents `AWAITING_AUTHORIZATION`)
- Collect LIVE requires `Idempotency-Key`
- Crypto address provision is idempotent per user
