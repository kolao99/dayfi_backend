# Security

- PIN never logged, never sent to LLM, never stored plaintext  
- Idempotency keys on money-moving ops (webhook retries, double taps)  
- Authorization from session / WhatsApp secure token / Telegram WebApp — never trust body userId  
- Transaction lifecycle is a state machine, not a boolean  
- Audit every sensitive event (`azap_audit_events`)  
- Prompt injection cannot bypass balance/KYC/PIN/consent checks
