# Azap Architecture

**Azap** = conversational financial agent (product).  
**Dayfi** = money movement / ledger / provider infrastructure.

## Principle

```
Channels → Azap Adapter → Conversation Core
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       Conversation        LLM/AI         Capability
          State             Layer           Registry
                              │
                              ▼
                         ACTION PLAN
                              │
                              ▼
                  DETERMINISTIC VALIDATOR
                              │
                              ▼
                       TOOL EXECUTOR
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           Dayfi          Providers       User entities
        (unchanged)                      (aliases)
```

The LLM **never** moves money. It proposes an `ActionPlan`.  
Deterministic services validate balances, fees, KYC, recipients, PIN, consent.  
Existing `/api/v1/four` + `four_*` + payment ledger stay as the money layer.

## Module map

| Path | Role |
|------|------|
| `src/modules/azap/` | New conversational foundation |
| `src/modules/four/` | Existing channel adapters + deterministic send/KYC/PIN (preserved) |
| `src/modules/payment/` | Dayfi wallet/ledger (do not rewrite) |

## Layers

1. **Capability Registry** — single source for `/`, `/help`, LLM tool descriptions  
2. **Conversation State** — persistent financial dialogue state (not LLM memory)  
3. **LLMProvider** — model-agnostic; Groq/stub implementations  
4. **ActionPlan** — up to 4 actions; statuses; confirmation/PIN flags  
5. **Entity aliases** — `Kola` → beneficiary; `home electricity` → biller  
6. **Notifications / Consent / Pricing / Audit** — beside conversation, not inside LLM  

## Compatibility

Do **not** rename during foundation:

- `/api/v1/four`
- `four_*` tables
- `FourError`, internal Four types

Build Azap **around** them.
