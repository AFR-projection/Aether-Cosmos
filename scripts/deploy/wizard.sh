#!/usr/bin/env bash
# Interactive wizard — generates .env without manual editing

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

prompt_into() {
  local label=$1
  local -n _out=$2
  local default=${3:-}
  if [[ -n "$default" ]]; then
    read -rp "$label [$default]: " _out </dev/tty
    _out="${_out:-$default}"
  else
    read -rp "$label: " _out </dev/tty
  fi
  _out="$(sanitize_env_value "$_out")"
}

prompt_secret_into() {
  local label=$1
  local -n _out=$2
  echo "  (input hidden — type it, then press Enter)" >&2
  read -rsp "$label: " _out </dev/tty
  echo >&2
  _out="$(sanitize_env_value "$_out")"
}

require_nonempty() {
  local label=$1
  local -n _val=$2
  while [[ -z "$_val" ]]; do
    warn "$label is required."
    prompt_into "$label" _val
  done
}

require_secret_nonempty() {
  local label=$1
  local -n _val=$2
  while [[ -z "$_val" ]]; do
    warn "$label is required."
    prompt_secret_into "$label" _val
  done
}

run_wizard() {
  print_banner "Setup wizard"

  local public_ip
  public_ip="$(get_public_ip)"

  echo "  This wizard writes .env for you. Enter = keep the default value."
  echo "  Secrets are hidden while typing and never shown again."
  echo

  section "Domain  ·  1 of 4"
  echo -e "  Public IP of this VPS: ${BOLD}${public_ip}${NC}"
  echo -e "  ${DIM}The domain's A record must already point at the IP above.${NC}"
  echo
  prompt_into "Domain (example: aether.example.com)" DEPLOY_DOMAIN
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN#https://}"
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN#http://}"
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN%%/*}"
  require_nonempty "Domain" DEPLOY_DOMAIN

  # Check DNS here, not later: if the A record does not point at the VPS yet, a
  # certbot failure 10 minutes from now is far more confusing than this warning.
  local resolved=""
  resolved="$(getent hosts "$DEPLOY_DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
  if [[ -z "$resolved" ]]; then
    warn "$DEPLOY_DOMAIN does not resolve yet — SSL will fail until DNS propagates"
  elif [[ "$resolved" == "$public_ip" ]]; then
    ok "DNS is correct ($DEPLOY_DOMAIN → $resolved)"
  else
    warn "$DEPLOY_DOMAIN points at $resolved, not $public_ip"
  fi

  prompt_into "Admin email (Let's Encrypt notifications)" CERTBOT_EMAIL "admin@${DEPLOY_DOMAIN}"

  section "Database  ·  2 of 4"
  echo -e "  ${DIM}Copy the connection string from the Neon dashboard — one whole line.${NC}"
  echo
  prompt_into "DATABASE_URL" DATABASE_URL
  require_nonempty "DATABASE_URL" DATABASE_URL

  section "Cloudflare R2  ·  3 of 4"
  echo -e "  ${DIM}dash.cloudflare.com → R2 → bucket → Manage API tokens.${NC}"
  echo
  prompt_into "R2 Account ID" R2_ACCOUNT_ID
  require_nonempty "R2 Account ID" R2_ACCOUNT_ID
  prompt_into "R2 Access Key ID" R2_ACCESS_KEY_ID
  require_nonempty "R2 Access Key ID" R2_ACCESS_KEY_ID
  prompt_secret_into "R2 Secret Access Key" R2_SECRET_ACCESS_KEY
  require_secret_nonempty "R2 Secret Access Key" R2_SECRET_ACCESS_KEY
  # The default is only for a fresh install. An existing deployment MUST type its
  # old bucket name — the bucket name is part of every object's address.
  prompt_into "R2 Bucket name" R2_BUCKET_NAME "aether-cosmos"
  prompt_into "R2 Public URL (https://pub-xxx.r2.dev)" R2_PUBLIC_URL
  require_nonempty "R2 Public URL" R2_PUBLIC_URL

  section "Admin account  ·  4 of 4"
  prompt_into "Admin username" MASTER_USERNAME "ByAFR"
  prompt_secret_into "Admin password (min 10 characters)" MASTER_PASSWORD
  while [[ ${#MASTER_PASSWORD} -lt 10 ]]; do
    warn "Admin password must be at least 10 characters."
    prompt_secret_into "Admin password (min 10 characters)" MASTER_PASSWORD
  done

  if command -v openssl >/dev/null 2>&1; then
    SESSION_SECRET="$(openssl rand -hex 32)"
  else
    SESSION_SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)"
  fi

  NEXT_PUBLIC_APP_URL="https://${DEPLOY_DOMAIN}"
  COOKIE_SECURE=true
  HSTS_ENABLED=true
  REDIS_URL=redis://redis:6379
  REDIS_DISABLED=false
  NODE_ENV=production

  # Summary before writing. Secret values only report their length — echoing the
  # contents leaves secrets sitting in the scrollback and in SSH logs.
  echo
  box_top
  box_row "Confirm" "$BOLD"
  box_mid
  box_kv "Domain" "$DEPLOY_DOMAIN"
  box_kv "URL" "$NEXT_PUBLIC_APP_URL"
  box_kv "Email" "$CERTBOT_EMAIL"
  box_kv "Database" "$(secret_hint "$DATABASE_URL")"
  box_kv "R2 bucket" "$R2_BUCKET_NAME"
  box_kv "R2 secret" "$(secret_hint "$R2_SECRET_ACCESS_KEY")"
  box_kv "Admin" "$MASTER_USERNAME"
  box_kv "Password" "$(secret_hint "$MASTER_PASSWORD")"
  box_kv "Secret" "generated automatically (64 hex)" "$DIM"
  box_bot
  echo

  local confirm=""
  read -rp "  Write .env and continue the deploy? [Y/n] " confirm </dev/tty || true
  case "${confirm,,}" in
    n|no) die "Cancelled — nothing was written. Run ./install.sh --wizard again any time." ;;
  esac

  mkdir -p "$ROOT/.deploy"
  echo "$DEPLOY_DOMAIN" > "$DOMAIN_FILE"

  cat > "$ENV_FILE" <<'ENVEOF'
# Generated by Aether Cosmos ByAFR install wizard
ENVEOF

  env_set_line NODE_ENV production
  env_set_line DEPLOY_DOMAIN "$DEPLOY_DOMAIN"
  env_set_line CERTBOT_EMAIL "$CERTBOT_EMAIL"
  env_set_line DATABASE_URL "$DATABASE_URL"
  env_set_line R2_ACCOUNT_ID "$R2_ACCOUNT_ID"
  env_set_line R2_ACCESS_KEY_ID "$R2_ACCESS_KEY_ID"
  env_set_line R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"
  env_set_line R2_BUCKET_NAME "$R2_BUCKET_NAME"
  env_set_line R2_PUBLIC_URL "$R2_PUBLIC_URL"
  env_set_line SESSION_SECRET "$SESSION_SECRET"
  env_set_line MASTER_USERNAME "$MASTER_USERNAME"
  env_set_line MASTER_PASSWORD "$MASTER_PASSWORD"
  env_set_line NEXT_PUBLIC_APP_URL "$NEXT_PUBLIC_APP_URL"
  env_set_line COOKIE_SECURE true
  env_set_line HSTS_ENABLED true
  env_set_line REDIS_URL redis://redis:6379
  env_set_line REDIS_DISABLED false
  # Upload limits, presigned URL lifetime, and login lockout are NOT written here
  # any more: they all live in Admin → Settings, are stored in the database, and
  # take effect within ~30 seconds without a redeploy. Writing them as env vars
  # only creates two sources of truth for the same number.

  echo "# Generated at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$ENV_FILE"

  save_deploy_state
  ok ".env created at $ENV_FILE"
  echo
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_wizard
fi
