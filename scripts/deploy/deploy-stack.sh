#!/usr/bin/env bash
# Build & start Docker stack + DB setup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

# One service at a time, retried — see build_service in common.sh for why serial.
deploy_stack() {
  log "Building containers (first time may take several minutes)..."
  build_all_images

  log "Starting Redis..."
  "${COMPOSE[@]}" up -d redis

  # The application and worker must not start against a fresh database before its
  # tables exist. The setup image is already built above and does not need Redis.
  log "Verifying R2, syncing the database, and bootstrapping the master account..."
  if ! "${COMPOSE[@]}" --profile setup run --rm setup; then
    fail "Production setup failed"
    die "Read the error above, then retry: ${COMPOSE[*]} --profile setup run --rm setup"
  fi
  ok "R2, database, and master account ready"

  log "Starting app and worker..."
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

}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  deploy_stack
fi
