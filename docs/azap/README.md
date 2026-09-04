# Azap by Dayfi

**Azap** is the conversational financial assistant product.
**Dayfi** is the infrastructure/company brand that powers Azap.

## Naming

| Context | Use |
|--------|-----|
| Conversational | Azap |
| Formal / onboarding | Azap by Dayfi |
| Meta WhatsApp display name (manual) | Azap by Dayfi |

## Config

```env
AZAP_ASSISTANT_NAME=Azap
AZAP_FULL_BRAND_NAME=Azap by Dayfi
AZAP_LLM_PROVIDER=stub   # or groq when AZAP_GROQ_API_KEY is set
# FOUR_ASSISTANT_NAME=Azap  # deprecated alias
```

## Architecture docs

- [architecture.md](./architecture.md)
- [conversation-engine.md](./conversation-engine.md)
- [action-plans.md](./action-plans.md)
- [tools.md](./tools.md)
- [security.md](./security.md)
- [notifications.md](./notifications.md)
- [consent.md](./consent.md)
- [whatsapp.md](./whatsapp.md)
- [testing.md](./testing.md)
- [CEO-E2E-TEST-MATRIX.md](./CEO-E2E-TEST-MATRIX.md) — Fund → Receive → Balance → Send → Bills (CEO QA bible)
- [CAPABILITY-INVENTORY.md](./CAPABILITY-INVENTORY.md) — Dayfi + SendHome → Azap adapter status
- [qa-capability-matrix.md](./qa-capability-matrix.md)
- [QA-FINAL-REPORT.md](./QA-FINAL-REPORT.md)

## Code

`src/modules/azap/` — foundation (capabilities, ActionPlan, LLM provider, entities, notifications, consent, pricing, audit).

`src/modules/four/` + `src/modules/payment/` — existing channel adapters and money layer (**do not rename**).

## Manual Meta step

WhatsApp Manager → Phone numbers → Profile → display name **Azap by Dayfi**.
