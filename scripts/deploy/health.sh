#!/usr/bin/env bash
# Post-deploy health checks

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_env

HEALTH_FAILED=0

status_line() {
  local ok_flag=$1 label=$2 detail=${3:-}
  if [[ $ok_flag -eq 0 ]]; then
    printf "  %-14s ${GREEN}OK${NC}   %s\n" "$label" "$detail"
  else
    printf "  %-14s ${RED}FAIL${NC} %s\n" "$label" "$detail"
    HEALTH_FAILED=1
  fi
}

check_app_http() {
  if curl -sf --max-time 10 "http://127.0.0.1:3000/api/auth/csrf" >/dev/null 2>&1; then
    status_line 0 "App" "HTTP responding"
  else
    status_line 1 "App" "no response"
  fi
}

check_nginx() {
  local state domain="${DEPLOY_DOMAIN:-}"
  state="$("${COMPOSE[@]}" ps nginx --format '{{.State}}' 2>/dev/null | head -n1 || echo "missing")"
  state="${state:-missing}"
  if [[ "$state" != "running" ]]; then
    status_line 1 "Nginx" "$state"
    return
  fi

  # Resolve locally so this verifies Nginx + the real hostname certificate without
  # depending on whether the VPS provider supports hairpinning its own public IP.
  if curl -sf --max-time 15 --resolve "${domain}:443:127.0.0.1" \
    "https://${domain}/api/auth/csrf" >/dev/null 2>&1; then
    status_line 0 "Nginx" "HTTPS responding"
  else
    status_line 1 "Nginx" "running, but HTTPS/certificate verification failed"
  fi
}

check_redis() {
  if "${COMPOSE[@]}" exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    status_line 0 "Redis" "PONG"
  else
    status_line 1 "Redis" "no PONG"
  fi
}

check_worker() {
  local logs state
  logs="$("${COMPOSE[@]}" logs worker --tail 30 2>/dev/null || true)"
  state="$("${COMPOSE[@]}" ps worker --format '{{.State}}' 2>/dev/null | head -n1 || echo "missing")"
  state="${state:-missing}"

  # Signatures, not the bare word "error": a worker that logs "job retried after error"
  # is working, and failing a whole deploy over that word teaches the operator to ignore
  # this line. These are the shapes a crash actually takes.
  if echo "$logs" | grep -qE "Cannot find module|MODULE_NOT_FOUND|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|FATAL|unhandled|[A-Za-z]*Error: "; then
    if [[ "$state" == "running" ]]; then
      status_line 1 "Worker" "running but crashing — ${COMPOSE[*]} logs worker --tail 50"
    else
      status_line 1 "Worker" "$state — ${COMPOSE[*]} logs worker --tail 50"
    fi
  elif [[ "$state" == "running" ]]; then
    status_line 0 "Worker" "running"
  else
    status_line 1 "Worker" "$state"
  fi
}

check_ssl() {
  local domain="${DEPLOY_DOMAIN:-}"
  domain="${domain,,}"
  local cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
  if root_test_f "$cert" && as_root openssl x509 -checkend 86400 -noout -in "$cert" >/dev/null 2>&1; then
    local expiry
    expiry="$(as_root openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2 || echo "?")"
    status_line 0 "SSL" "valid until $expiry"
  elif root_test_f "$cert"; then
    status_line 1 "SSL" "expired or expires within 24 hours"
  else
    status_line 1 "SSL" "certificate missing"
  fi
}

check_email() {
  # Soft check: warn when no verified Gmail sender is configured — OTP + security
  # notifications need at least one. Email delivery is stateless (SMTP), so there
  # is no session volume to verify; we just look for a ready sender in the DB.
  local count
  count="$(docker_run --rm --env-file "$ENV_FILE" postgres:16-alpine sh -c \
    "apk add --no-cache postgresql-client >/dev/null 2>&1 && psql \"\$DATABASE_URL\" -tAc \"SELECT count(*) FROM mail_senders WHERE is_active AND status='ok'\" 2>/dev/null" 2>/dev/null | tr -d '[:space:]')"

  if [[ "$count" =~ ^[0-9]+$ && "$count" -ge 1 ]]; then
    status_line 0 "Email" "$count verified Gmail sender(s) ready"
  else
    # Not a hard fail on a fresh install — the admin still needs to add a sender.
    printf "  %-14s ${YELLOW}WARN${NC} %s\n" "Email" "no verified sender — add one in Admin → Email"
  fi
}

check_database_quick() {
  init_docker 2>/dev/null || true
  if docker_run --rm --env-file "$ENV_FILE" postgres:16-alpine sh -c \
    "apk add --no-cache postgresql-client >/dev/null 2>&1 && psql \"\$DATABASE_URL\" -c 'SELECT 1' >/dev/null 2>&1" 2>/dev/null; then
    status_line 0 "Database" "connected"
  else
    status_line 1 "Database" "connection failed"
  fi
}

run_health() {
  init_docker 2>/dev/null || true
  echo
  log "Health check"
  echo
  check_redis
  check_app_http
  check_worker
  check_nginx
  check_database_quick
  check_ssl
  check_email
  echo
  if [[ $HEALTH_FAILED -ne 0 ]]; then
    fail "Some checks failed. Run: aether logs"
    return 1
  fi
  ok "All services healthy"
  echo
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_health
fi
