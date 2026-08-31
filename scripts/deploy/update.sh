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
[[ $# -eq 0 ]] || die "Usage: aether update [--force]"

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
  local before="" after="" branch=""
  if [[ -d .git ]]; then
    before="$(git rev-parse HEAD 2>/dev/null || true)"
    branch="$(git branch --show-current)"
    [[ -n "$branch" ]] || die "The VPS checkout is in detached HEAD state — check out a branch before updating"

    if [[ "$FORCE_RESET" == "true" ]]; then
      warn "Force reset mode — discarding tracked local changes and local commits"
      git fetch origin "$branch"
      git reset --hard "origin/${branch}"
      ok "Repository reset to origin"
    else
      # A normal update is deliberately non-destructive. Auto-stashing is not safe:
      # it makes work appear to vanish, and a later hard reset can discard local
      # commits the operator never agreed to lose. --force is the explicit escape
      # hatch for a disposable server checkout.
      if [[ -n "$(git status --porcelain)" ]]; then
        fail "The VPS checkout has local changes; a normal update will not hide or discard them."
        fail "Keep them: cd $ROOT && git stash, then rerun 'aether update'."
        die "Discard tracked changes instead: aether update --force"
      fi

      git fetch origin "$branch"
      if ! git merge --ff-only "origin/${branch}"; then
        fail "Not possible to fast-forward safely; no local commit was discarded."
        fail "Keep local commits: rebase them onto origin/${branch}, then rerun the update."
        die "Discard local commits instead: aether update --force"
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
  build_all_images
  "${COMPOSE[@]}" up -d redis

  step "Verifying R2 and syncing the database schema"
  "${COMPOSE[@]}" --profile setup run --rm setup

  # Start the new application only after its database schema is ready. On a fresh
  # database this prevents the worker from querying tables that do not exist yet;
  # on an update the old app stays up until this point.
  "${COMPOSE[@]}" up -d app worker

  step "Certificate and nginx"
  if [[ -f "$NGINX_TEMPLATE" ]]; then
    bash "$SCRIPT_DIR/ssl.sh"
    bash "$SCRIPT_DIR/nginx.sh"
    "${COMPOSE[@]}" up -d nginx
  else
    "${COMPOSE[@]}" up -d
  fi

  step "Health check"
  bash "$SCRIPT_DIR/health.sh" || die "Update completed with health failures"
  print_final_status "https://${DEPLOY_DOMAIN}" "$(( SECONDS - started ))"
}

main "$@"
