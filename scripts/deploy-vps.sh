#!/usr/bin/env bash
# Sync dayfi_backend to Hetzner VPS and rebuild the API container.
# Usage: ./scripts/deploy-vps.sh
# Requires: SSH access (set VPS_HOST, e.g. export VPS_HOST=root@YOUR_NEW_IP)
# See docs/NEW_INFRA_SETUP.md if api.dayfi.co is down.

set -euo pipefail

VPS_HOST="${VPS_HOST:-root@169.58.199.93}"
VPS_DIR="${VPS_DIR:-/root/dayfi_backend}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Syncing ${ROOT} to ${VPS_HOST}:${VPS_DIR}/"
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'deploy/.env' \
  --exclude '.env' \
  --exclude 'dist' \
  "${ROOT}/" \
  "${VPS_HOST}:${VPS_DIR}/"

echo "→ Rebuilding API on VPS…"
ssh "${VPS_HOST}" "cd ${VPS_DIR}/deploy && docker compose -f docker-compose.prod.yml up -d --build api"

echo "→ Health check"
curl -sS "https://api.dayfi.co/api/v1/health"
echo
curl -sS "https://api.dayfi.co/api/v1/health/ready"
echo
echo "Done."
