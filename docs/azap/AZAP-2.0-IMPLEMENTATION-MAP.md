# Azap 2.0 — Implementation Map

> Internal map before multimodal expansion. Soft-launch rails must not regress.
>
> See also: [`whatsapp.md`](./whatsapp.md), [`QA-FINAL-REPORT.md`](./QA-FINAL-REPORT.md)

## North star

```text
ANY INPUT → UNDERSTAND → CONVERSATION | ACTION → STRUCTURED INTENT
  → VALIDATION → CONFIRM → PIN → RAILS → LEDGER → RECEIPT
```

LLM never executes money. Voice/image are modalities into the same engine.

## Current production path

| Layer | Entry | Notes |
|-------|--------|--------|
| WhatsApp | `whatsappWebhookService` → `whatsappRouter` | Voice/image acknowledged (STT/vision scaffold) |
| Telegram | `telegramWebhookService` → `telegramRouter` | Same engine |
| Understanding | `intentParser` (primary) + Groq planner (fallback) | Deterministic money slice |
| Dialogue (Phase 1) | `routeKind` + `naturalReply` + `dialogueContext` | Chat vs action; pronoun sends |
| Orchestration | `conversationEngine.handleUserText` | Slot FSMs via `four_active_intents` |
| Azap slash/menu | `azapCore` + `capabilities/registry` | |
| Auth | secure URL `/setup-pin` `/authorize` `/kyc` + `authorizeService` | Browser checkpoint |
| Push | `deliverAzapPush` | Templates only |
| Rails | Flutterwave (NGN/bills), YC (`SEND_YC`), crypto USDC/EURC | |
| Asset registry | `azap/crypto/assetRegistry` | Config-driven; YC buy coins off until entitlement |
| State scaffold | `azap_conversation_state` | Now used for last-recipient context |

## Phase status

| Phase | Focus | Status |
|-------|--------|--------|
| **1** | Natural conversation vs action, personality, multi-turn polish | **Shipped** |
| **1c** | Conversational brain (LLM reason → chat \| structured action) | **Shipped** (`conversationalBrain.ts` + Groq `reason`) |
| **2** | Voice → STT → same engine | Scaffold (`modality/voiceIngest` + WA media hook) |
| **3** | Image → vision entities → confirm → engine | Scaffold (`modality/imageIngest` + WA media hook) |
| **4** | Asset/network config + YC buy-to-wallet | Registry scaffold; YC off-ramp exists |
| Soft launch | FLW float, E2E money, USDC/EURC honesty, browser PIN | Do not block |

## Non-goals for Phase 1

- Rewriting payment/ledger/webhooks
- Meta Flows dependency
- Holding BTC/ETH/SOL inventory
- Auto-execute from voice/image

## Key files (Phase 1+)

- `src/modules/azap/conversation/routeKind.ts`
- `src/modules/azap/conversation/naturalReply.ts`
- `src/modules/azap/conversation/dialogueContext.ts`
- `src/modules/azap/conversation/conversationalBrain.ts`
- `src/modules/azap/conversation/solutionOriented.ts`
- `src/modules/azap/modality/voiceIngest.ts`
- `src/modules/azap/modality/imageIngest.ts`
- `src/modules/azap/crypto/assetRegistry.ts`
- `src/modules/four/engine/conversationEngine.ts`
- `src/modules/four/telegram/onboardingService.ts`
- `src/modules/four/engine/intentParser.ts`
- `tests/azap/conversation/azap-2-dialogue.test.ts`
- `tests/azap/conversation/solution-oriented.test.ts`
