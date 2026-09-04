# Notifications

Notifications sit **beside** the conversation engine.

```
Event → NotificationService → Template (versioned) → Channel adapter (WhatsApp/email)
```

Templates are deterministic. Optional AI personalization only for non-legal copy.

Events: `transaction_success|failed|pending`, `kyc_*`, `security_alert`, `pricing_update`, `billing_consent_required`, `statement_ready`, `maintenance_notice`.

Deduplicate by `(user_id, event, idempotency_key)`.
