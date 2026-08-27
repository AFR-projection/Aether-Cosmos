#!/usr/bin/env bash
# Full production install orchestrator

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

USE_WIZARD=0
SKIP_SSL=0
FIX_ENV=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wizard) USE_WIZARD=1; shift ;;
    --skip-wizard) shift ;; # legacy, no-op
    --skip-ssl) SKIP_SSL=1; shift ;;
    --force-wizard) USE_WIZARD=1; shift ;; # legacy alias
    --fix-env) FIX_ENV=1; shift ;;
    --help|-h)
      echo "Usage: ./install.sh [--wizard] [--skip-ssl] [--fix-env]"
      echo ""
      echo "  Default: use a hand-written .env (cp .env.example .env → nano .env)"
      echo "  --wizard     Interactive wizard (optional)"
      echo "  --fix-env    Repair a broken .env (multiline/quotes)"
      echo "  --skip-ssl   Skip SSL (testing only)"
      echo ""
      echo "  Fresh VPS from scratch (install Docker, clone, open .env, deploy):"
      echo "    curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-Cosmos/main/scripts/deploy/setup.sh | bash"
      echo ""
      echo "  Once installed, everything runs through one command: aether help"
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

main() {
  local started=$SECONDS
  print_banner "First install"
  cd "$ROOT"

  # 6 steps on the happy path; --skip-ssl merges two of them away, which is why the
  # total is computed rather than hardcoded — a "[5/6]" that never reaches 6 looks
  # like something crashed.
  if [[ $SKIP_SSL -eq 0 ]]; then step_init 6; else step_init 5; fi

  step "Docker"
  ensure_docker

  if [[ $FIX_ENV -eq 1 ]]; then
    [[ -f "$ENV_FILE" ]] || die "No .env to fix"
    normalize_env_file
    autofill_env
    load_env
    bash "$SCRIPT_DIR/validate.sh"
    exit $?
  fi

  step "Configuration"
  if [[ $USE_WIZARD -eq 1 ]]; then
    bash "$SCRIPT_DIR/wizard.sh"
  else
    require_env_file
    ok "Using .env"
    normalize_env_file
    # Fill in what can be derived from what the operator typed, so a hand-written
    # .env does not fail validation over NODE_ENV or a missing SESSION_SECRET.
    autofill_env
  fi

  load_env

  step "Checking .env, database, R2, DNS, ports"
  bash "$SCRIPT_DIR/validate.sh"

  if [[ $SKIP_SSL -eq 0 ]]; then
    step "HTTPS certificate"
    bash "$SCRIPT_DIR/ssl.sh"
    bash "$SCRIPT_DIR/nginx.sh"
  else
    warn "SSL skipped — only for development testing"
  fi

  step "Building and starting containers"
  bash "$SCRIPT_DIR/deploy-stack.sh"

  if [[ $SKIP_SSL -eq 0 ]]; then
    log "Starting nginx (HTTPS)..."
    "${COMPOSE[@]}" up -d nginx
  fi

  step "Health check"
  if bash "$SCRIPT_DIR/health.sh"; then
    print_final_status "https://${DEPLOY_DOMAIN}" "$(( SECONDS - started ))"
  else
    warn "Deploy finished with warnings — review health output above"
    print_final_status "https://${DEPLOY_DOMAIN}" "$(( SECONDS - started ))"
    exit 1
  fi
}

main "$@"
