#!/usr/bin/env bash
# Push local .env vars to Railway dayfi-api service (excludes DAYFI_DATABASE_URL — use Postgres reference).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${RAILWAY_SERVICE:-dayfi-api}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if ! command -v railway >/dev/null; then
  echo "Install Railway CLI: npm i -g @railway/cli && railway login" >&2
  exit 1
fi

cd "$ROOT"

echo "→ Linking Postgres DATABASE_URL to $SERVICE"
railway variable set \
  --service "$SERVICE" \
  'DAYFI_DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  SWITCH_NODE_ENV=production \
  DAYFI_NODE_ENV=production

if [[ -f "$ENV_FILE" ]]; then
  echo "→ Syncing vars from $ENV_FILE (skip DAYFI_DATABASE_URL)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"
    val="${val#\"}"
    val="${val%\'}"
    val="${val#\'}"
    case "$key" in
      DAYFI_DATABASE_URL|DAYFI_PORT|SWITCH_NODE_ENV|DAYFI_NODE_ENV) continue ;;
    esac
    [[ -z "$key" ]] && continue
    echo "  $key"
    railway variable set --service "$SERVICE" "${key}=${val}" --skip-deploys
  done < "$ENV_FILE"
fi

echo "→ Done. Deploy with: railway up --service $SERVICE"
