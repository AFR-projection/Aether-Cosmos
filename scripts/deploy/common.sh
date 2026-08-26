#!/usr/bin/env bash
# Shared helpers for Aether Cosmos ByAFR deployment scripts

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
DIM='\033[2m'
NC='\033[0m'

log()  { echo -e "${CYAN}==>${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*" >&2; }
die()  { fail "$*"; exit 1; }

# ── Frame drawing ─────────────────────────────────────────────────────────────
# Padding is computed from the plain text, never from the string that carries the
# colour escapes — `${#s}` counts those escapes as characters and every box would
# come out ragged.
BOX_W=62
BOX_RULE="$(printf '─%.0s' $(seq 1 $BOX_W))"
SUB_RULE="$(printf '─%.0s' $(seq 1 42))"

box_top() { printf "${DIM}╭%s╮${NC}\n" "$BOX_RULE"; }
box_mid() { printf "${DIM}├%s┤${NC}\n" "$BOX_RULE"; }
box_bot() { printf "${DIM}╰%s╯${NC}\n" "$BOX_RULE"; }

box_row() {
  local text=${1:-} color=${2:-} pad
  pad=$(( BOX_W - 2 - ${#text} ))
  (( pad < 0 )) && pad=0
  printf "${DIM}│${NC} ${color}%s${NC}%*s ${DIM}│${NC}\n" "$text" "$pad" ""
}

box_kv() {
  local label=$1 value=$2 color=${3:-} plain pad
  plain="$(printf '%-11s %s' "$label" "$value")"
  pad=$(( BOX_W - 2 - ${#plain} ))
  (( pad < 0 )) && pad=0
  printf "${DIM}│${NC} ${BOLD}%-11s${NC} ${color}%s${NC}%*s ${DIM}│${NC}\n" \
    "$label" "$value" "$pad" ""
}

# ── Step counter ──────────────────────────────────────────────────────────────
# Only the orchestrator calls step(); the sub-scripts it invokes are separate
# processes and could not share the counter anyway.
STEP_TOTAL=0
STEP_N=0
step_init() { STEP_TOTAL=${1:-0}; STEP_N=0; }

step() {
  STEP_N=$(( STEP_N + 1 ))
  echo
  if (( STEP_TOTAL > 0 )); then
    printf "${BOLD}${CYAN}[%d/%d]${NC} ${BOLD}%s${NC}\n" "$STEP_N" "$STEP_TOTAL" "$1"
  else
    printf "${BOLD}${CYAN}==>${NC} ${BOLD}%s${NC}\n" "$1"
  fi
  printf "${DIM}%s${NC}\n" "$BOX_RULE"
}

# A heading inside a step, for scripts the orchestrator runs as a child. It carries
# no number on purpose: a "[2/4]" nested under the installer's own "[2/6]" reads
# like the counter jumped backwards.
section() {
  echo
  printf "${BOLD}${CYAN}  ▸ ${NC}${BOLD}%s${NC}\n" "$1"
  printf "${DIM}  %s${NC}\n" "$SUB_RULE"
}

elapsed_human() {
  local secs=${1:-0}
  if (( secs < 60 )); then
    printf '%ds' "$secs"
  else
    printf '%dm %ds' "$(( secs / 60 ))" "$(( secs % 60 ))"
  fi
}

# Report that a secret was captured without putting it back on screen. Length only:
# a scrollback buffer, an SSH log, or a screen share would otherwise carry the value
# out of the machine it was typed into.
#
# ASCII mask on purpose. Box padding is computed with `${#s}`, which counts bytes
# unless the locale is UTF-8, so a row of bullets would come out short on a host
# with LANG unset.
secret_hint() {
  local v=${1:-}
  if [[ -z "$v" ]]; then
    printf 'belum diisi'
  else
    printf '********** (%d karakter)' "${#v}"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Command '$1' not found. Install it first."
}

# Run a command as root: directly when we already are, through sudo otherwise.
# Every privileged call in these scripts goes through here instead of carrying its
# own `if [[ $EUID -eq 0 ]]` copy.
#
# Note the `env` form for anything needing a variable: `FOO=bar sudo cmd` sets FOO
# for sudo, which then drops it. `as_root env FOO=bar cmd` is the shape that works.
as_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

# /etc/letsencrypt/live and /archive are 0700 root:root, so an unprivileged
# `[[ -f … ]]` on a certificate returns false even when the file is right there —
# certbot reports success and the very next check calls the cert missing. Test
# privileged paths through this, never with a bare [[ -f ]].
root_test_f() {
  as_root test -f "$1"
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

app_version() {
  local v=""
  if [[ -f "$ROOT/package.json" ]]; then
    v="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/package.json" | head -n1)"
  fi
  printf '%s' "${v:-0.0.0}"
}

print_banner() {
  local subtitle=${1:-Production deploy}
  echo
  box_top
  box_row "AETHER COSMOS ByAFR   v$(app_version)" "$BOLD"
  box_row "$subtitle" "$DIM"
  box_bot
}

print_final_status() {
  local url="${1:-https://${DEPLOY_DOMAIN:-unknown}}"
  local seconds=${2:-}
  # A hand-rolled install never ran setup.sh, so `aether` is not on PATH there.
  # Print the form that actually works on this machine rather than the prettier one.
  local cli="aether"
  command -v aether >/dev/null 2>&1 || cli="./bin/aether"
  echo
  box_top
  box_row "DEPLOYED" "${GREEN}${BOLD}"
  box_mid
  box_kv "URL" "$url" "$BOLD"
  box_kv "Admin" "${MASTER_USERNAME:-see .env}"
  [[ -n "$seconds" ]] && box_kv "Took" "$(elapsed_human "$seconds")" "$DIM"
  box_mid
  box_row "Next:" "$DIM"
  box_row "  $cli status     health of every service"
  box_row "  $cli logs       follow the logs"
  box_row "  $cli update     pull, rebuild, migrate, verify"
  [[ "$cli" == "./bin/aether" ]] && \
    box_row "  sudo install -m 0755 bin/aether /usr/local/bin/" "$DIM"
  box_bot
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
