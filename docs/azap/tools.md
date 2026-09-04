# Tools

Tools are typed, risk-classified, and invoked only by the **Tool Executor** after validation.

## Risk

| Risk | Examples | Gate |
|------|----------|------|
| low | get_balance, get_rates, list_saved_recipients | session |
| high | bank_transfer, bill_payment, withdraw | KYC + confirmation + PIN + idempotency |

## Registry

`src/modules/azap/tools/` defines name, schemas, requirements.  
Implementations call existing Dayfi/`four`/`payment` services — they do not invent balances.

## LLM

The model may **select** tools / propose ActionPlans.  
The backend decides whether execution is allowed.
