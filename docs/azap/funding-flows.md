# Azap funding flows (wired to Dayfi)

## Conversation state

`four_active_intents.intent = FUND_CRYPTO` (24h TTL), slots: `method`, `asset`, `network`.

Buttons (`fund_crypto`) and typed phrases (`USDC on Stellar`) update the **same** intent.

Generic help (`genericNudge`) is skipped while this intent is active or the message parses as a crypto asset/network.

## Crypto funding (P0 — live)

1. Insufficient NGN send → Fund with Crypto / Bank transfer (NGN)
2. Fund with Crypto → `beginCryptoFunding` → ask asset (USDC, EURC only)
3. `USDC on Stellar` (or asset then network) → `isCryptoDepositSupported` → `provisionCryptoWalletsForUser` → unique address
4. Unsupported combo → list **actual** networks for that asset

Direct shortcuts:

- Fund my wallet with USDC on Stellar
- Deposit USDC (asks network)
- Deposit EURC (Stellar / Ethereum only)
- What's my USDC Stellar address?

## Fiat funding (P1)

Bank transfer (NGN) uses **the same Flutterwave virtual account** as the Dayfi app (`ensureNgnVirtualAccount`). If BVN is missing, Azap opens the existing KYC Mini App. It does **not** invent account numbers.

## Fiat payout

Four `SEND_MONEY` + Flutterwave resolve + Yellow Card payout. Review includes Dayfi fee (`estimateTransferFeeNgn`). PIN via WhatsApp/Telegram Mini App.

## Crypto withdrawal from Azap

`SEND_CRYPTO` → `routeCryptoSend` after PIN. Address format is rail-specific (Stellar `G…` vs EVM `0x…`). Capability registry must allow the asset/network.

## Files

- `src/config/cryptoNetworks.ts` — networks/assets
- `src/modules/azap/capabilities/moneyCapabilities.ts` — registry + NL parse
- `src/modules/four/finance/cryptoDepositFlow.ts` — deposit address
- `src/modules/four/engine/conversationEngine.ts` — continuation
- `src/modules/four/whatsapp/whatsappRouter.ts` / `telegramRouter.ts` — persist on button
