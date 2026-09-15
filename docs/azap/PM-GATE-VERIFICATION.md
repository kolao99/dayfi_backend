# Azap PM Gate — Code-Level Verification (pre-deploy)

**Status:** Conversation safety verified. **Launch decision lives in `LAUNCH-READINESS.md` — not “wait for YC.”**  
**Do not commit/deploy until PM signs off on launch readiness.**

Date: 2026-09-15

**Product:** Azap Money — Nigeria first (Flutterwave NGN + bills + custodial USDC/EURC).  
YC crypto direct settlement is **deferred**, not a launch blocker.

---

## A. Where the LLM gets conversation history

- `conversationalBrain.buildHistory()` → `listMessages(userId, conversationId, { limit: 16 })`  
  File: `src/modules/azap/conversation/conversationalBrain.ts`  
  Messages: `four_messages` via `src/modules/four/conversation/messageService.ts`  
  Passed into Groq as alternating `user` / `assistant` turns after the system prompt.

## B. Where the LLM gets product capability facts

- System prompt: `capabilityFactsForPrompt()` from `solutionOriented.ts`  
- Grounded Q&A (no LLM invent): `tryAnswerCapabilityQuestion()` → `getSoftLaunchCapabilities()` / `assetRegistry` (`listEnabledAssets`, `AZAP_ASSET_REGISTRY`)  
- Called **before** LLM in `runConversationalBrain` so “what coins / buy BTC” are backend-truth.

## C. Where the LLM gets account / transaction state

- Active workflow summary: `getActiveIntentForConversation` → JSON of intent/status/amount/pending recipient  
- Last recipient: `getLastMoneyContext` → `azap_conversation_state.resolvedEntities.lastMoney`  
- **Not yet injected:** live wallet balance / pending TX hash into the LLM prompt (balance only via deterministic `balance_check` action).  
  Gap acknowledged: open-ended “why is my transfer pending?” answers with process guidance + “ask status”; full TX lookup still uses existing intel flows when user hits those intents.

## D. How LLM action proposals are schema validated

- `mapActions()` in `conversationalBrain.ts` whitelists types only:  
  `bank_transfer | crypto_deposit | crypto_transfer | fiat_funding | balance_check | airtime_purchase | bill_payment | kyc | crypto_buy | crypto_sell | crypto_swap`  
- Unknown types dropped; empty action list → chat refuse (no execute).  
- `normalizeBrainResult()` re-maps + scrubs.  
- Legacy planner path still uses `validateActionPlan` in `proposeActionPlanFromText` (`azapCore.ts` → `actionPlan/validator.ts`).

## E. How action proposals enter the secure flow

- `conversationEngine.handleUserText` → `runConversationalBrain`  
- On `kind === 'action'`: `dispatchFirstPlanAction`  
- `bank_transfer` → re-enters `handleUserText(..., skipPlanner: true)` as a Send phrase → existing recipient resolve → `finalizeSendReview` → `AWAITING_CONFIRMATION` → browser PIN (`authorizeService`) → FLW/etc.  
- Never calls FLW/YC/ledger from the brain.

## F. How fabricated success is prevented

- Prompt forbids claiming sent/saved/funded  
- `scrubUnsafeClaims()` strips success/balance invention from model output  
- Applied to chat replies and action notes after Groq `reason()` / `complete()`  
- Execution receipts only from `authorizeService` + `deliverAzapPush` after real provider/ledger paths

## G. Fallback when Groq unavailable

- `createLlmProviderFromEnv()` → stub if no key / `AZAP_LLM_PROVIDER=stub`  
- `stubBrain()`: capability Qs + light conversational heuristics (not a giant intent DB)  
- Deterministic money FSMs still run **before** the brain (send/fund/bills/active slots)  
- Explicit: full ChatGPT-level chat needs production Groq key on VPS

## H. Malformed JSON from LLM

- `reason()` catch → null → try `complete()` JSON parse  
- Parse fail → `stubBrain`  
- Never throws into webhook; engine wraps brain in try/catch

## I. Unsupported action proposals

- Whitelist drop in `mapActions`  
- Empty actions after normalize → chat: “can't do that exact action yet…”  
- `crypto_buy/sell` in dispatch: **USDC/EURC → custodial fund / NGN off-ramp** (launch path). Other assets → YC trade gate (honest not-ready). Never provider buy execution from the brain.

## J. What prevents PIN/KYC/auth bypass

- Brain cannot call `authorizeIntentWithPin`  
- Send path always hits `finalizeSendReview` → review UI → secure URL PIN  
- KYC gated in `finalizeSendReview` via `buildKycProfileSnapshot`  
- `skipPlanner: true` on re-entry still uses the same resolve/PIN pipeline

---

## Deterministic money rails

**Untouched as executors:** Flutterwave, Yellow Card send, ledger, webhooks, browser authorize, PIN setup.

**Touched only for UX copy / context:** recipient-not-found → setup, bank-then-account collection, resume “actually send 10k instead”, cancel copy.

---

## Tests run

| Suite | Result |
|-------|--------|
| `npm run test:azap` | **76 passing** (npm `**` glob undercount) |
| Azap full glob | **89 passing** |
| Intent parser | **25 passing** |
| DB `test:four-engine` | **19 passing** |

### Interrupt/defer fix (2026-09-15)

Explicit new send supersedes active collection; deferrals never populate bank/account slots; ambiguous Kola clarification kept after interrupt.

---

## Launch readiness (replaces “wait for YC”)

PM GO/NO-GO for **shipping Azap Money** is tracked in **`LAUNCH-READINESS.md`**.

| Track | Role |
|-------|------|
| This doc (A–J) | Conversation + PIN/KYC/fake-success safety |
| `LAUNCH-READINESS.md` | Nigeria NGN + custodial USDC/EURC + ops reconcile |
| `CRYPTO-TRADE-GATE.md` | Multi-asset engine + **future** YC crypto rail |

### Crypto rails (summary)

| Rail | Status |
|------|--------|
| Custodial DayFi USDC/EURC (fund/deposit/send) | Launch path — see launch checklist |
| YC `discoveredPairs` / direct settlement | **[]** — deferred; **not** a launch blocker |
| BTC/ETH/SOL user buy/sell | Hidden until E2E |

---

## Remaining honesty

1. Stub mode ≠ ChatGPT; production needs Groq.  
2. Live balances/pending TX details are not fully in the LLM context bag yet — only active intent + last recipient + capability registry.  
3. “Which Kola?” multi-match still depends on existing recipient resolver ambiguity paths.  
4. DayFi USDC/EURC is **custodial** — never market as non-custodial.  
5. Full launch still **PARTIAL** until bills float, async payout safety, and custody↔ledger reconcile are proven (`LAUNCH-READINESS.md`).
