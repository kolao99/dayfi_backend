# Consent

Versioned `ConsentRecord`:

- `consent_type` + `version`  
- `status`: presented | accepted | rejected | expired  
- channel, source, auth method, audit metadata  

LLM never invents consent status — it calls `ConsentService`.

Billing / terms updates present a new version; old acceptance does not cover v2.
