#!/usr/bin/env bash
# Safe production update

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

FORCE_RESET=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE_RESET=true
  shift
fi

main() {
  local started=$SECONDS
  print_banner "Update"
  cd "$ROOT"
  [[ -f "$ENV_FILE" ]] || die "No .env — run ./install.sh first"

  load_env
  ensure_docker
  step_init 7

  step "Backing up .env and nginx config"
  mkdir -p "$ROOT/.deploy/backups"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_FILE" "$ROOT/.deploy/backups/.env.${stamp}"
  [[ -f "$NGINX_GEN" ]] && cp "$NGINX_GEN" "$ROOT/.deploy/backups/nginx.${stamp}.conf"
  ok "Backup saved to .deploy/backups/"

  step "Fetching the latest code"
  local before="" after=""
  if [[ -d .git ]]; then
    before="$(git rev-parse HEAD 2>/dev/null || true)"
    log "git pull..."

    if [[ "$FORCE_RESET" == "true" ]]; then
      warn "Force reset mode — discarding all local changes"
      git fetch origin
      git reset --hard origin/"$(git branch --show-current)"
      ok "Repository reset to origin"
    else
      # Check for uncommitted changes
      if ! git diff-index --quiet HEAD --; then
        warn "Uncommitted local changes detected"
        log "Stashing local changes..."
        git stash push -m "Auto-stash before update $(date +%Y%m%d-%H%M%S)"
      fi

      # Fetch latest
      git fetch origin

      # Try fast-forward first
      if ! git pull --ff-only origin "$(git branch --show-current)" 2>/dev/null; then
        warn "Cannot fast-forward — trying rebase..."
        if ! git rebase origin/"$(git branch --show-current)"; then
          warn "Rebase failed — resetting to origin"
          git rebase --abort 2>/dev/null || true
          log "Resetting to origin/$(git branch --show-current)..."
          git reset --hard origin/"$(git branch --show-current)"
        fi
      fi

      ok "Repository updated"
    fi

    after="$(git rev-parse HEAD 2>/dev/null || true)"
    # Saying "already up to date" out loud matters: without it, a no-op update looks
    # identical to a real one and the operator cannot tell whether the pull worked.
    if [[ -n "$before" && "$before" == "$after" ]]; then
      ok "Already at the latest commit ($(git log -1 --format=%h))"
    elif [[ -n "$before" ]]; then
      log "New commits:"
      # `|| true`: head closes the pipe after ten lines, git dies of SIGPIPE, and
      # pipefail would otherwise abort the whole update over a cosmetic listing.
      git log --oneline --no-decorate "${before}..${after}" | head -n 10 | sed 's/^/    /' || true
    fi
  fi

  step "Checking .env, database, R2, DNS, ports"
  bash "$SCRIPT_DIR/validate.sh"

  step "Rebuilding containers"
  "${COMPOSE[@]}" build app worker setup
  "${COMPOSE[@]}" up -d redis app worker

  step "Syncing the database schema"
  "${COMPOSE[@]}" --profile setup run --rm setup

  step "Certificate and nginx"
  if [[ -f "$NGINX_TEMPLATE" ]]; then
    bash "$SCRIPT_DIR/ssl.sh" 2>/dev/null || warn "SSL renew skipped"
    bash "$SCRIPT_DIR/nginx.sh" || warn "Nginx config generation skipped"
    "${COMPOSE[@]}" up -d nginx
  else
    "${COMPOSE[@]}" up -d
  fi

  step "Health check"
  bash "$SCRIPT_DIR/health.sh" || die "Update completed with health failures"
  print_final_status "https://${DEPLOY_DOMAIN}" "$(( SECONDS - started ))"
}

main "$@"
