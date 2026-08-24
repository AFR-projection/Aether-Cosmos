#!/usr/bin/env bash
# Shared helpers for Storage ByAFR deployment scripts

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
DOCKER=(docker)
COMPOSE=(docker compose -f "$COMPOSE_FILE")
ENV_FILE="$ROOT/.env"
DEPLOY_STATE="$ROOT/.deploy/state.env"
NGINX_GEN="$ROOT/docker/generated/nginx.conf"
NGINX_TEMPLATE="$ROOT/docker/nginx.conf.template"
DOMAIN_FILE="$ROOT/.deploy/domain"

# Compose picks the Bake builder when COMPOSE_BAKE=true, but Bake needs the buildx
# plugin. On a host with COMPOSE_BAKE=true and no buildx, every `compose build` prints
# "configured to build using Bake, but buildx isn't installed" and silently falls back
# to the classic builder anyway. So: if buildx is present, leave the host's choice
# alone; if it isn't, force Bake off (exported so every sourced sub-script inherits it).
# Build output is identical either way -- this only removes the spurious warning.
if docker buildx version >/dev/null 2>&1; then
  export COMPOSE_BAKE="${COMPOSE_BAKE:-false}"   # buildx present: keep host's choice, default off
else
  export COMPOSE_BAKE=false                      # no buildx: Bake can't work, don't ask for it
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}==>${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*" >&2; }
die()  { fail "$*"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Command '$1' not found. Install it first."
}

get_public_ip() {
  curl -sf --max-time 5 ifconfig.me 2>/dev/null \
    || curl -sf --max-time 5 icanhazip.com 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || echo "unknown"
}

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then return 0; fi
  DEPLOY_DOMAIN="$(env_get DEPLOY_DOMAIN)"
  CERTBOT_EMAIL="$(env_get CERTBOT_EMAIL)"
  DATABASE_URL="$(env_get DATABASE_URL)"
  R2_ACCOUNT_ID="$(env_get R2_ACCOUNT_ID)"
  R2_ACCESS_KEY_ID="$(env_get R2_ACCESS_KEY_ID)"
  R2_SECRET_ACCESS_KEY="$(env_get R2_SECRET_ACCESS_KEY)"
  R2_BUCKET_NAME="$(env_get R2_BUCKET_NAME)"
  R2_PUBLIC_URL="$(env_get R2_PUBLIC_URL)"
  NEXT_PUBLIC_APP_URL="$(env_get NEXT_PUBLIC_APP_URL)"
  SESSION_SECRET="$(env_get SESSION_SECRET)"
  MASTER_USERNAME="$(env_get MASTER_USERNAME)"
  MASTER_PASSWORD="$(env_get MASTER_PASSWORD)"
  if [[ -f "$DEPLOY_STATE" ]]; then
    # shellcheck disable=SC1090
    source "$DEPLOY_STATE"
  fi
}

# Strip quotes, whitespace, and accidental line breaks from .env values
sanitize_env_value() {
  local v=$1
  v="${v//$'\r'/}"
  v="${v//$'\n'/}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ "$v" == \"*\" && "$v" == *\" ]]; then
    v="${v:1:${#v}-2}"
  fi
  printf '%s' "$v"
}

env_get() {
  local key=$1
  [[ -f "$ENV_FILE" ]] || return 0
  local line val
  line="$(grep -m1 "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
  [[ -z "$line" ]] && return 0
  val="${line#*=}"
  sanitize_env_value "$val"
}

env_set_line() {
  local key=$1
  local val=$2
  val="$(sanitize_env_value "$val")"
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

# Fix broken wizard output (multiline quoted values) → KEY=value per line
normalize_env_file() {
  [[ -f "$ENV_FILE" ]] || return 0
  local tmp current_key="" val="" line=""
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*# || -z "${line//[[:space:]]/}" ]]; then
      printf '%s\n' "$line" >> "$tmp"
      continue
    fi
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      if [[ -n "$current_key" ]]; then
        val="$(sanitize_env_value "$val")"
        printf '%s=%s\n' "$current_key" "$val" >> "$tmp"
      fi
      current_key="${line%%=*}"
      val="${line#*=}"
    elif [[ -n "$current_key" ]]; then
      val+="${line}"
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$ENV_FILE"
  if [[ -n "$current_key" ]]; then
    val="$(sanitize_env_value "$val")"
    printf '%s=%s\n' "$current_key" "$val" >> "$tmp"
  fi
  if cmp -s "$ENV_FILE" "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 0
  fi
  mv "$tmp" "$ENV_FILE"
  ok "File .env dinormalisasi (format KEY=value)"
}

save_deploy_state() {
  mkdir -p "$(dirname "$DEPLOY_STATE")"
  cat > "$DEPLOY_STATE" <<EOF
DEPLOY_DOMAIN=${DEPLOY_DOMAIN:-}
CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
EOF
}

init_docker() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    # init_docker runs several times per deploy (validate, health, …) and each sourced
    # sub-script is a fresh shell. Warn ONCE and export the flag so children inherit it,
    # instead of printing the same line six times.
    if [[ -z "${_DOCKER_SUDO_WARNED:-}" ]]; then
      warn "Docker pakai sudo — fix permanen: sudo usermod -aG docker \$USER && newgrp docker"
      export _DOCKER_SUDO_WARNED=1
    fi
  else
    die "Docker tidak bisa diakses. Install: curl -fsSL https://get.docker.com | sh"
  fi
  COMPOSE=("${DOCKER[@]}" compose -f "$COMPOSE_FILE")
}

docker_run() {
  "${DOCKER[@]}" run "$@"
}

ensure_docker() {
  need_cmd docker
  init_docker
  if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    die "Docker Compose tidak tersedia"
  fi
  ok "Docker & Compose ready"
}

require_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return 0
  fi
  echo
  echo "File .env belum ada. Buat manual (disarankan):"
  echo
  echo "  cp .env.example .env"
  echo "  nano .env          # isi DATABASE_URL, R2, domain, dll."
  echo "  ./install.sh"
  echo
  echo "Wizard interaktif (opsional): ./install.sh --wizard"
  echo
  die "Buat .env dulu lalu jalankan ulang ./install.sh"
}

port_free() {
  local port=$1
  ! ss -tln 2>/dev/null | grep -q ":${port} " && ! netstat -tln 2>/dev/null | grep -q ":${port} "
}

stop_nginx_container() {
  "${COMPOSE[@]}" stop nginx 2>/dev/null || true
}

start_nginx_container() {
  "${COMPOSE[@]}" up -d nginx
}

print_banner() {
  echo
  echo -e "${BOLD}==========================================${NC}"
  echo -e "${BOLD}  Storage ByAFR — Production Installer${NC}"
  echo -e "${BOLD}==========================================${NC}"
  echo
}

print_final_status() {
  local url="${1:-https://${DEPLOY_DOMAIN:-unknown}}"
  echo
  echo -e "${BOLD}==========================================${NC}"
  echo -e "${GREEN}${BOLD}  Deployment Complete${NC}"
  echo -e "${BOLD}==========================================${NC}"
  echo -e "  Application : ${GREEN}Running${NC}"
  echo -e "  URL         : ${BOLD}${url}${NC}"
  echo -e "  Admin login : MASTER_USERNAME / MASTER_PASSWORD (from setup)"
  echo
  echo "  Commands:"
  echo "    ./update.sh          Update safely"
  echo "    npm run deploy:logs  View logs"
  echo "    npm run deploy:health  Re-check services"
  echo -e "${BOLD}==========================================${NC}"
  echo
}

_auto_init_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    return 0
  fi
  COMPOSE=("${DOCKER[@]}" compose -f "$COMPOSE_FILE")
}

_auto_init_docker
