#!/usr/bin/env bash
# Safe production update

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

main() {
  print_banner
  cd "$ROOT"
  [[ -f "$ENV_FILE" ]] || die "No .env — run ./install.sh first"

  load_env
  ensure_docker

  log "Backing up configuration..."
  mkdir -p "$ROOT/.deploy/backups"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_FILE" "$ROOT/.deploy/backups/.env.${stamp}"
  [[ -f "$NGINX_GEN" ]] && cp "$NGINX_GEN" "$ROOT/.deploy/backups/nginx.${stamp}.conf"
  ok "Backup saved to .deploy/backups/"

  if [[ -d .git ]]; then
    log "git pull..."
    git pull --ff-only
  fi

  bash "$SCRIPT_DIR/validate.sh"

  log "Rebuilding containers..."
  "${COMPOSE[@]}" build app worker setup
  "${COMPOSE[@]}" up -d redis app worker

  log "Database migration..."
  "${COMPOSE[@]}" --profile setup run --rm setup

  if [[ -f "$NGINX_TEMPLATE" ]]; then
    bash "$SCRIPT_DIR/ssl.sh" 2>/dev/null || warn "SSL renew skipped"
    bash "$SCRIPT_DIR/nginx.sh" || warn "Nginx config generation skipped"
    "${COMPOSE[@]}" up -d nginx
  else
    "${COMPOSE[@]}" up -d
  fi

  bash "$SCRIPT_DIR/health.sh" || die "Update completed with health failures"
  ok "Update complete — https://${DEPLOY_DOMAIN}"
}

main "$@"
