#!/usr/bin/env bash
# Pre-flight validation before build/deploy

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

VALIDATION_FAILED=0
VALIDATION_WARN=0

check_mark() {
  if [[ $1 -eq 0 ]]; then ok "$2"; else fail "$2"; VALIDATION_FAILED=1; fi
}

check_warn() {
  if [[ $1 -eq 0 ]]; then ok "$2"; else warn "$2"; VALIDATION_WARN=1; fi
}

validate_domain_format() {
  log "Checking domain..."
  local d="${DEPLOY_DOMAIN:-}"
  if [[ -z "$d" ]]; then
    d="${NEXT_PUBLIC_APP_URL#https://}"
    d="${d#http://}"
    d="${d%%/*}"
  fi
  DEPLOY_DOMAIN="$d"
  if [[ -z "$d" ]]; then
    check_mark 1 "DEPLOY_DOMAIN kosong — set di .env atau NEXT_PUBLIC_APP_URL"
    return
  fi
  if [[ "$d" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
    check_mark 0 "Domain format: $d"
  else
    check_mark 1 "Domain format invalid: $d"
  fi
}

validate_database_url() {
  log "Checking DATABASE_URL..."
  if [[ -z "${DATABASE_URL:-}" ]]; then
    check_mark 1 "DATABASE_URL kosong"
    return
  fi
  if [[ ! "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
    check_mark 1 "DATABASE_URL harus postgresql://..."
    return
  fi
  if [[ "$DATABASE_URL" == *'>' ]] || [[ "$DATABASE_URL" != *'sslmode='* ]]; then
    check_mark 1 "DATABASE_URL TERPOTONG — paste 1 baris penuh dari Neon (akhir: sslmode=require)"
    return
  fi
  check_mark 0 "DATABASE_URL format OK"

  init_docker 2>/dev/null || true
  if docker_run --rm --env-file "$ENV_FILE" postgres:16-alpine sh -c \
    "apk add --no-cache postgresql-client >/dev/null 2>&1 && psql \"\$DATABASE_URL\" -c 'SELECT 1' >/dev/null 2>&1" 2>/dev/null; then
    ok "Database connection OK"
  else
    local vps_ip
    vps_ip="$(get_public_ip)"
    check_warn 1 "Database live test skip/gagal — lanjut deploy (cek Neon IP Allow: ${vps_ip})"
  fi
}

validate_r2() {
  log "Checking R2 credentials..."
  load_env
  local missing=0
  for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME R2_PUBLIC_URL; do
    if [[ -z "${!v:-}" ]]; then
      missing=1
      fail "$v kosong"
    fi
  done
  [[ $missing -eq 1 ]] && { VALIDATION_FAILED=1; return; }
  check_mark 0 "R2 variables OK"

  local endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  init_docker 2>/dev/null || true
  if docker_run --rm \
    -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=auto \
    amazon/aws-cli:2.15.0 s3 ls "s3://${R2_BUCKET_NAME}" --endpoint-url "$endpoint" >/dev/null 2>&1; then
    ok "R2 bucket accessible"
  else
    check_warn 1 "R2 live test skip/gagal — lanjut deploy (cek credential di Cloudflare)"
  fi
}

validate_app_url() {
  log "Checking NEXT_PUBLIC_APP_URL..."
  if [[ "${NEXT_PUBLIC_APP_URL:-}" == https://* ]]; then
    check_mark 0 "HTTPS URL: $NEXT_PUBLIC_APP_URL"
  else
    check_mark 1 "Production wajib HTTPS — NEXT_PUBLIC_APP_URL=https://domain.com"
  fi
}

validate_dns() {
  log "Checking DNS..."
  local ip server_ip
  server_ip="$(get_public_ip)"
  ip="$(getent ahostsv4 "$DEPLOY_DOMAIN" 2>/dev/null | awk '{print $1; exit}' || dig +short "$DEPLOY_DOMAIN" 2>/dev/null | head -n1 || true)"
  if [[ -z "$ip" ]]; then
    warn "DNS belum resolve — pastikan A record $DEPLOY_DOMAIN → $server_ip"
    return
  fi
  if [[ "$ip" == "$server_ip" ]]; then
    ok "DNS OK: $DEPLOY_DOMAIN → $ip"
  else
    warn "DNS $DEPLOY_DOMAIN → $ip (VPS IP: $server_ip) — SSL mungkin gagal jika tidak match"
  fi
}

validate_session_secret() {
  log "Checking SESSION_SECRET..."
  if [[ ${#SESSION_SECRET} -ge 32 ]]; then
    check_mark 0 "SESSION_SECRET length OK"
  else
    check_mark 1 "SESSION_SECRET terlalu pendek (min 32 char)"
  fi
}

validate_required_env() {
  log "Checking required .env keys..."
  local missing=0
  for v in MASTER_USERNAME MASTER_PASSWORD CERTBOT_EMAIL; do
    if [[ -z "${!v:-}" ]]; then
      missing=1
      fail "$v kosong"
    fi
  done
  [[ $missing -eq 0 ]] && ok "Admin & SSL email OK" || VALIDATION_FAILED=1
}

validate_ports() {
  log "Checking ports 80 & 443..."
  local ok80=0 ok443=0
  port_free 80 && ok80=1
  port_free 443 && ok443=1
  if [[ $ok80 -eq 1 && $ok443 -eq 1 ]]; then
    check_mark 0 "Port 80 & 443 available"
  else
    warn "Port 80/443 in use — akan di-stop sementara untuk SSL setup"
  fi
}

run_validate() {
  echo
  log "Pre-flight validation"
  echo
  [[ -f "$ENV_FILE" ]] || die "File .env tidak ada. cp .env.example .env lalu isi manual."
  normalize_env_file
  load_env
  validate_required_env
  validate_domain_format
  validate_app_url
  validate_session_secret
  validate_database_url
  validate_r2
  validate_dns
  validate_ports
  echo
  if [[ $VALIDATION_FAILED -ne 0 ]]; then
    die "Validasi gagal — perbaiki .env (nano .env) lalu ./install.sh"
  fi
  ok "Validasi lulus — lanjut deploy"
  [[ $VALIDATION_WARN -ne 0 ]] && warn "Ada peringatan di atas — deploy tetap jalan"
  echo
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  init_docker 2>/dev/null || true
  run_validate
fi
