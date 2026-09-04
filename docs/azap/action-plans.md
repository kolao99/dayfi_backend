# Action Plans

Canonical multi-action representation (max **4** actions in v1).

```json
{
  "conversationId": "...",
  "actions": [
    {
      "id": "action_1",
      "type": "bank_transfer",
      "status": "needs_resolution",
      "amount": "2000",
      "currency": "NGN",
      "recipientReference": "Kola"
    }
  ],
  "requiresConfirmation": true,
  "requiresPin": true
}
```

## Action statuses

`draft` → `needs_resolution` → `ready` → `awaiting_review` → `awaiting_confirmation` → `awaiting_pin` → `authorized` → `processing` → `pending` → `succeeded`

Failures: `cancelled` | `expired` | `failed` | `reversed`

Batch: `partially_completed` when some succeed and some fail.

## Rules

1. LLM proposes actions; never executes money tools.  
2. Validator fills fees, balance, KYC, entity IDs from Dayfi.  
3. One review + one PIN for the batch.  
4. Each action keeps its own provider/transaction id and status.
