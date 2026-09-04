# Testing

## CEO / product QA

Use **[`CEO-E2E-TEST-MATRIX.md`](./CEO-E2E-TEST-MATRIX.md)** as the source of truth for conversational money coverage:

**Fund → Receive → Balance → Send → Bills**, plus chaos cases.

Product rules baked into that matrix:

- One USDC wallet; local currencies are rails + valuations  
- Buy USDC = fund; sell USDC = off-ramp/send  
- Balance-in-naira is valuation, not a trade  
- Bills = VAS purchase, not P2P send  
- Never fake provider success; never call dead `/wallets/swap`

Capability status: [`qa-capability-matrix.md`](./qa-capability-matrix.md)  
Latest run notes: [`QA-FINAL-REPORT.md`](./QA-FINAL-REPORT.md)

## Foundation / unit

Foundation tests cover:

- Capability registry completeness & `/help` formatting  
- ActionPlan typing / max-4 actions  
- Entity alias resolve / not found / ambiguous  
- LLM stub produces ActionPlan without calling money APIs  
- Conversation state read/write shape  
- Intent parser (valuation, buy→fund, sell→send, swap refuse)  
- Bills / messy-language NL  

```bash
npm run test:four-intent-parser
npm run test:azap
# needs Docker Postgres:
npm run db:up && npm run test:four-engine
```

Never assert fake provider success in production paths.
