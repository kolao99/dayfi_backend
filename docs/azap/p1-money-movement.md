# Azap P1 — money movement (WhatsApp → Dayfi)

Azap is the conversational interface. **Dayfi services remain the financial source of truth.** The LLM never executes money, never invents balances/fees/addresses, and never sees a PIN.

## What P1 wired

| Area | Status |
|---|---|
| NGN bank funding | Real Flutterwave VA via `ensureNgnVirtualAccount` / `beginNgnBankFunding`. Requires BVN + email (same as `POST /payments/wallets/add/fiat/ngn`). |
| NGN send | Existing Four `SEND_MONEY` → name enquiry → fee from `estimateTransferFeeNgn` → PIN Mini App → `executeBankSend`. KYC via `canSendMoney` (tier ≥ 2 + BVN). |
| Crypto deposit | Unchanged P0 path: capability registry + `provisionCryptoWalletsForUser`. Continuation `USDC on Stellar` after Fund with Crypto. |
| Crypto send | `SEND_CRYPTO` intent → review → same PIN Mini App → `routeCryptoSend` + ledger `recordCryptoOutboundLedger`. No NGN/BVN gate. |
| Buy / sell / swap | **Buy → fund USDC** (fiat VA or crypto deposit). **Sell → NGN send/off-ramp.** True USDC↔EURC swap unavailable (`POST /wallets/swap` is **410 Gone**); Azap refuses honestly. |
| Balance / history | Canonical **USDC** via `buildBalanceReply`; NGN/GHS valuations via `buildBalanceInCurrencyReply` + Dayfi FX; send-cost quotes via `buildSendCostQuoteReply`. |
| LLM | `GroqLLMProvider` POSTs JSON to Groq when `AZAP_LLM_PROVIDER=groq` or a Groq key is set. Stub fallback on failure. Structured ActionPlan only. |
| Idempotency | WhatsApp `wamid` / Twilio `MessageSid` stored as `four_messages.client_message_id` (unique). Duplicate inbound is ignored. PIN authorize requires `AWAITING_AUTHORIZATION`. |
| Notifications | Flutterwave NGN credit + Stellar inflow credit + PIN result push to WhatsApp/Telegram via `deliverAzapPush`. |

## ActionPlan

LLM output is validated (`src/modules/azap/actionPlan/`). Max **4** actions. The engine dispatches the **first** action through Dayfi services; remaining actions are listed, not batch-executed. Partial success language is required if a later executor is added.

The model must not include PIN, secrets, or KYC numbers.

## Conversation vs transaction state

- Conversation / slots: `four_active_intents` (`COLLECTING_INFORMATION`, `AWAITING_CONFIRMATION`, …)
- Money: Dayfi wallets, `wallet_transactions`, provider/chain status (`pending` / success / fail). Never tell the user a send succeeded from the LLM.

## KYC matrix (actual Dayfi)

| Rail | Gate |
|---|---|
| NGN Flutterwave VA funding | BVN on user + email |
| NGN send / Yellow Card payout | `canSendMoney`: KYC tier ≥ 2 and BVN |
| Crypto deposit / send | Wallet provisioned + PIN for send. **Not** BVN unless a future Dayfi rule says so. |

## Idempotency keys

- Inbound WhatsApp: `client_message_id`
- Ledger crypto out: `crypto-out:{txHash}`
- Stellar in: `stellar-in:{horizon id}`
- Flutterwave: existing deposit processor duplicate flag

## Unsupported on Azap (do not fake)

- USDC/EURC on Solana, Base, or any network not in the **runtime** registry
- On-chain asset-to-asset swap (USDC↔EURC); do not call the dead `/wallets/swap` endpoint
- Fake NGN/GHS “wallet balances” that are only valuations
- MoMo funding from WhatsApp unless the same Dayfi VA/channel API is used (NGN bank VA is the funded P1 path)
- Guessing saved recipients by name without `savedRecipient` / alias match

## Files

- `src/modules/four/finance/fiatFundingFlow.ts`
- `src/modules/four/finance/cryptoSendFlow.ts`
- `src/modules/four/finance/walletIntelService.ts`
- `src/modules/four/finance/azapNotifyService.ts`
- `src/modules/azap/llm/groqProvider.ts`
- `src/modules/four/engine/conversationEngine.ts`
- `src/modules/four/intent/authorizeService.ts`
