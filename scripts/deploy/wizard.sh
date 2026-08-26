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
  echo "  (input tersembunyi — ketik lalu Enter)" >&2
  read -rsp "$label: " _out </dev/tty
  echo >&2
  _out="$(sanitize_env_value "$_out")"
}

require_nonempty() {
  local label=$1
  local -n _val=$2
  while [[ -z "$_val" ]]; do
    warn "$label wajib diisi."
    prompt_into "$label" _val
  done
}

require_secret_nonempty() {
  local label=$1
  local -n _val=$2
  while [[ -z "$_val" ]]; do
    warn "$label wajib diisi."
    prompt_secret_into "$label" _val
  done
}

run_wizard() {
  print_banner "Setup wizard"

  local public_ip
  public_ip="$(get_public_ip)"

  echo "  Wizard ini menulis .env untukmu. Enter = pakai nilai default."
  echo "  Secret disembunyikan saat diketik dan tidak pernah ditampilkan lagi."
  echo

  section "Domain  ·  1 dari 4"
  echo -e "  IP publik VPS ini: ${BOLD}${public_ip}${NC}"
  echo -e "  ${DIM}A record domain harus sudah mengarah ke IP di atas.${NC}"
  echo
  prompt_into "Domain (contoh: aether.example.com)" DEPLOY_DOMAIN
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN#https://}"
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN#http://}"
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN%%/*}"
  require_nonempty "Domain" DEPLOY_DOMAIN

  # Cek DNS di sini, bukan nanti: kalau A record belum mengarah ke VPS, certbot
  # yang gagal 10 menit kemudian jauh lebih membingungkan daripada peringatan ini.
  local resolved=""
  resolved="$(getent hosts "$DEPLOY_DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
  if [[ -z "$resolved" ]]; then
    warn "$DEPLOY_DOMAIN belum resolve — SSL akan gagal sampai DNS jadi"
  elif [[ "$resolved" == "$public_ip" ]]; then
    ok "DNS sudah benar ($DEPLOY_DOMAIN → $resolved)"
  else
    warn "$DEPLOY_DOMAIN mengarah ke $resolved, bukan $public_ip"
  fi

  prompt_into "Email admin (notifikasi Let's Encrypt)" CERTBOT_EMAIL "admin@${DEPLOY_DOMAIN}"

  section "Database  ·  2 dari 4"
  echo -e "  ${DIM}Ambil connection string dari dashboard Neon — satu baris utuh.${NC}"
  echo
  prompt_into "DATABASE_URL" DATABASE_URL
  require_nonempty "DATABASE_URL" DATABASE_URL

  section "Cloudflare R2  ·  3 dari 4"
  echo -e "  ${DIM}dash.cloudflare.com → R2 → bucket → Manage API tokens.${NC}"
  echo
  prompt_into "R2 Account ID" R2_ACCOUNT_ID
  require_nonempty "R2 Account ID" R2_ACCOUNT_ID
  prompt_into "R2 Access Key ID" R2_ACCESS_KEY_ID
  require_nonempty "R2 Access Key ID" R2_ACCESS_KEY_ID
  prompt_secret_into "R2 Secret Access Key" R2_SECRET_ACCESS_KEY
  require_secret_nonempty "R2 Secret Access Key" R2_SECRET_ACCESS_KEY
  # Default hanya untuk install baru. Deployment yang sudah jalan WAJIB
  # mengetik nama bucket lamanya — nama bucket bagian dari alamat objek.
  prompt_into "R2 Bucket name" R2_BUCKET_NAME "aether-cosmos"
  prompt_into "R2 Public URL (https://pub-xxx.r2.dev)" R2_PUBLIC_URL
  require_nonempty "R2 Public URL" R2_PUBLIC_URL

  section "Akun admin  ·  4 dari 4"
  prompt_into "Admin username" MASTER_USERNAME "ByAFR"
  prompt_secret_into "Admin password (min 10 karakter)" MASTER_PASSWORD
  while [[ ${#MASTER_PASSWORD} -lt 10 ]]; do
    warn "Password admin minimal 10 karakter."
    prompt_secret_into "Admin password (min 10 karakter)" MASTER_PASSWORD
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

  # Ringkasan sebelum menulis. Nilai rahasia hanya dilaporkan panjangnya —
  # menampilkan ulang isinya bikin secret nongkrong di scrollback dan di log SSH.
  echo
  box_top
  box_row "Konfirmasi" "$BOLD"
  box_mid
  box_kv "Domain" "$DEPLOY_DOMAIN"
  box_kv "URL" "$NEXT_PUBLIC_APP_URL"
  box_kv "Email" "$CERTBOT_EMAIL"
  box_kv "Database" "$(secret_hint "$DATABASE_URL")"
  box_kv "R2 bucket" "$R2_BUCKET_NAME"
  box_kv "R2 secret" "$(secret_hint "$R2_SECRET_ACCESS_KEY")"
  box_kv "Admin" "$MASTER_USERNAME"
  box_kv "Password" "$(secret_hint "$MASTER_PASSWORD")"
  box_kv "Secret" "digenerate otomatis (64 hex)" "$DIM"
  box_bot
  echo

  local confirm=""
  read -rp "  Tulis ke .env dan lanjut deploy? [Y/n] " confirm </dev/tty || true
  case "${confirm,,}" in
    n|no) die "Dibatalkan — tidak ada yang ditulis. Jalankan ./install.sh --wizard lagi kapan saja." ;;
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
  # Batas upload, umur presigned URL, dan lockout login TIDAK ditulis di
  # sini lagi: semuanya ada di Admin → Settings, tersimpan di database dan
  # kena efek dalam ~30 detik tanpa redeploy. Menulisnya sebagai env cuma
  # bikin dua sumber kebenaran untuk angka yang sama.

  echo "# Generated at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$ENV_FILE"

  save_deploy_state
  ok "File .env dibuat di $ENV_FILE"
  echo
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_wizard
fi
