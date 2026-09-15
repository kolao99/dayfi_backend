# Mainnet cutover — Stellar + Ethereum

Date: 2026-09-15

## Production targets

| Network | Config |
|---------|--------|
| Stellar | `STELLAR_NETWORK=mainnet`, Horizon `https://horizon.stellar.org`, passphrase PUBLIC |
| Ethereum | `ETH_NETWORK=mainnet`, chainId **1** |

## Fail-closed

On `DAYFI_NODE_ENV=production` / `NODE_ENV=production` / Railway:

- Refuse start if Stellar is not mainnet or Horizon is testnet/localhost
- Refuse start if ETH_NETWORK is sepolia/testnet
- Probe Horizon + Ethereum `eth_chainId=0x1` at boot
- Stellar send asserts Mainnet passphrase before sign/submit
- EVM send asserts `chainId === 1` before transfer

## Preflight

```bash
npx ts-node -r dotenv/config scripts/mainnet-preflight.ts
```

## Still not Mainnet execution

- Infra Stellar live modes (`DAYFI_INFRA_STELLAR_*`, settlement adapter) remain **Testnet-only / mock by design**
- YC crypto direct settlement still **NO-GO**
- Test scripts under `scripts/*testnet*` unchanged (tests only)

## Launch blockers (ops)

1. Master wallet XLM liquidity (~2.12 XLM observed) may be below provision gate (~2.55 XLM/user)
2. No large-value smoke transfer yet — connectivity only verified
3. Ledger ↔ custody reconcile still operationally PARTIAL
