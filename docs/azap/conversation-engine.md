# Conversation Engine

Azap conversation is **state-driven**, not message-position-driven.

## Entry points (same core)

- Natural language (“Send 5k to Kola”)
- Slash commands (`/balance`, `/pay`, …)
- Buttons / lists
- Proactive notifications → deep links into flows

## Persistent state (`azap_conversation_state`)

Tracks:

- user, channel, conversation id  
- current intent / action plan id  
- missing slots, resolved entities  
- confirmation / PIN / KYC / consent flags  
- active flow, expiration, idempotency keys  

LLM chat history is **not** the source of truth for financial slots.

## Follow-ups

Ask only for **missing** fields. Retain prior slots across turns.

## PIN isolation

Digits that look like PIN during `awaiting_pin` are handled by the secure path.  
LLM receives only `pin_verified: true|false`.

## Buttons

Selections update state; other options remain conceptually available (disabled/selected markup where the channel allows).
