#!/usr/bin/env bash
# Copy Stellar master wallet env from dayfi.wallet into dayfi_backend.
# Usage: ./scripts/sync-stellar-env-from-wallet.sh [target-env-file]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WALLET_ENV="${DAYFI_WALLET_ENV:-$ROOT/../dayfi.wallet/backend/.env}"
TARGET="${1:-$ROOT/.env}"

if [[ ! -f "$WALLET_ENV" ]]; then
  echo "Missing wallet env: $WALLET_ENV" >&2
  exit 1
fi

if [[ ! -f "$TARGET" ]]; then
  echo "Missing target env: $TARGET" >&2
  exit 1
fi

read_env() {
  local key="$1"
  grep -E "^${key}=" "$WALLET_ENV" | tail -1 | cut -d= -f2- | sed 's/^"//;s/"$//'
}

upsert() {
  local key="$1"
  local val="$2"
  if grep -qE "^${key}=" "$TARGET"; then
    perl -i -pe "s|^${key}=.*|${key}=\"${val}\"|" "$TARGET"
  else
    echo "${key}=\"${val}\"" >> "$TARGET"
  fi
}

STELLAR_NETWORK="$(read_env STELLAR_NETWORK)"
STELLAR_HORIZON="$(read_env STELLAR_HORIZON_URL)"
MASTER_PUB="$(read_env MASTER_WALLET_PUBLIC_KEY)"
MASTER_ENC="$(read_env MASTER_ENCRYPTED_SECRET_KEY)"
WALLET_KEY="$(read_env WALLET_ENCRYPTION_KEY)"

[[ -n "$STELLAR_NETWORK" ]] && upsert STELLAR_NETWORK "$STELLAR_NETWORK"
[[ -n "$STELLAR_HORIZON" ]] && upsert STELLAR_HORIZON_URL "$STELLAR_HORIZON"
[[ -n "$MASTER_PUB" ]] && upsert MASTER_WALLET_PUBLIC_KEY "$MASTER_PUB"
[[ -n "$MASTER_ENC" ]] && upsert MASTER_ENCRYPTED_SECRET_KEY "$MASTER_ENC"
[[ -n "$WALLET_KEY" ]] && upsert MASTER_WALLET_ENCRYPTION_KEY "$WALLET_KEY"

# dayfi_backend uses 1 XLM per user (trustlines sponsored by master)
upsert STELLAR_FUNDING_AMOUNT_XLM "1"

USDC="$(read_env USDC_ISSUER)"
[[ -n "$USDC" ]] && upsert USDC_ISSUER "$USDC"

echo "Synced Stellar master wallet vars from $WALLET_ENV → $TARGET"
echo "  MASTER_WALLET_PUBLIC_KEY=${MASTER_PUB:0:8}..."
echo "  STELLAR_FUNDING_AMOUNT_XLM=1"
