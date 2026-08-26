#!/usr/bin/env bash
# Update running VPS deployment (git pull + rebuild)
# Usage: ./scripts/vps-update.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker/docker-compose.yml)

echo "==> Aether Cosmos ByAFR — Update"

if [[ -d .git ]]; then
  echo "==> git pull..."
  git pull --ff-only
fi

echo "==> Rebuild & restart..."
"${COMPOSE[@]}" up -d --build

echo "==> Done. Logs: npm run deploy:logs"
