#!/usr/bin/env bash
# Build & start Docker stack + DB setup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

deploy_stack() {
  log "Building containers (first time may take several minutes)..."
  "${COMPOSE[@]}" build app worker setup

  log "Starting redis, app, worker..."
  "${COMPOSE[@]}" up -d redis
  "${COMPOSE[@]}" up -d app worker

  log "Waiting for app to become healthy..."
  local i ready=0
  for i in $(seq 1 60); do
    if curl -sf http://127.0.0.1:3000/api/auth/csrf >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 3
  done
  if [[ $ready -ne 1 ]]; then
    fail "App failed to start. Logs:"
    "${COMPOSE[@]}" logs app --tail 40
    die "Deploy aborted — fix errors above"
  fi
  ok "App is healthy"

  log "Running database migration + admin bootstrap..."
  if ! "${COMPOSE[@]}" --profile setup run --rm setup; then
    fail "Database setup failed"
    die "Check DATABASE_URL and run: ${COMPOSE[*]} --profile setup run --rm setup"
  fi
  ok "Database ready"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  deploy_stack
fi
