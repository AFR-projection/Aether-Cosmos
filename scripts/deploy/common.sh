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

# The Dockerfiles use `RUN --mount=type=cache` for the npm cache, which the classic
# builder rejects outright. BuildKit is the default in modern Docker, but a host with
# DOCKER_BUILDKIT=0 in its environment would fail the build on syntax rather than on
# anything real — so ask for it explicitly.
export DOCKER_BUILDKIT=1

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

# Set a key in place, or append it when it is absent. Appending a second copy is not
# good enough: env_get takes the FIRST match while docker compose takes the LAST, so
# a duplicate key means the script and the container disagree about its value.
# Duplicates already in the file are collapsed onto the first occurrence.
env_put() {
  local key=$1 val tmp line replaced=0
  val="$(sanitize_env_value "$2")"
  if [[ ! -f "$ENV_FILE" ]] || ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    env_set_line "$key" "$val"
    return 0
  fi
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      if [[ $replaced -eq 0 ]]; then
        printf '%s=%s\n' "$key" "$val" >> "$tmp"
        replaced=1
      fi
      continue
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$ENV_FILE"
  # Copy the contents rather than mv the file: .env keeps its owner and 0600 mode,
  # and mktemp's 0600-root file does not land on top of the operator's .env.
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# True when a value is still one of the literal examples from .env.example. Matched
# exactly, not by substring: a real Neon URL or R2 key must never be mistaken for a
# placeholder and block a deploy that would have worked.
env_is_placeholder() {
  case "${1:-}" in
    postgresql://user:pass@*|postgres://user:pass@*) return 0 ;;
    change-me-openssl-rand-hex-32) return 0 ;;
    change-this-strong-password-min-10-chars) return 0 ;;
    your_account_id|your_access_key|your_secret_key) return 0 ;;
    aether.example.com|https://aether.example.com|http://aether.example.com) return 0 ;;
    admin@example.com) return 0 ;;
    https://pub-xxxx.r2.dev) return 0 ;;
  esac
  return 1
}

# Hand-written .env is the supported path, so fill in everything that can be derived
# instead of failing validation over it. Only values nobody can guess — database, R2,
# domain, admin, certbot email — are left to the operator.
autofill_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  local domain url secret k v

  domain="$(env_get DEPLOY_DOMAIN)"
  url="$(env_get NEXT_PUBLIC_APP_URL)"
  env_is_placeholder "$domain" && domain=""
  env_is_placeholder "$url" && url=""

  # Either one is enough; the other follows from it.
  if [[ -z "$domain" && -n "$url" ]]; then
    domain="${url#http*://}"
    domain="${domain%%/*}"
    env_put DEPLOY_DOMAIN "$domain"
    ok "DEPLOY_DOMAIN diisi dari NEXT_PUBLIC_APP_URL: $domain"
  elif [[ -n "$domain" && -z "$url" ]]; then
    env_put NEXT_PUBLIC_APP_URL "https://${domain}"
    ok "NEXT_PUBLIC_APP_URL diisi dari DEPLOY_DOMAIN: https://${domain}"
  fi

  # SESSION_SECRET is generated, never typed. Written ONLY when missing, still the
  # placeholder, or too short to be accepted — replacing a live one would make every
  # saved Gmail App Password and the brain embedding key undecryptable.
  secret="$(env_get SESSION_SECRET)"
  if [[ -z "$secret" ]] || env_is_placeholder "$secret" || (( ${#secret} < 32 )); then
    if [[ -n "$secret" ]] && ! env_is_placeholder "$secret"; then
      warn "SESSION_SECRET kurang dari 32 karakter — diganti yang baru."
      warn "Kalau ini deployment lama: input ulang Gmail App Password (Admin → Email) dan API key embedding."
    fi
    env_put SESSION_SECRET "$(gen_secret)"
    ok "SESSION_SECRET digenerate otomatis (64 hex)"
  fi

  # One correct answer each for this stack, so a missing line is never worth an error.
  # R2_BUCKET_NAME is deliberately NOT in here: the bucket name is part of every
  # object's address, so guessing one would hide an existing deployment's files.
  while IFS='=' read -r k v; do
    [[ -n "$k" ]] || continue
    [[ -z "$(env_get "$k")" ]] || continue
    env_put "$k" "$v"
    ok "Default dipakai: ${k}=${v}"
  done <<'ENV_DEFAULTS'
NODE_ENV=production
COOKIE_SECURE=true
HSTS_ENABLED=true
REDIS_URL=redis://redis:6379
REDIS_DISABLED=false
ENV_DEFAULTS
}

# 64 hex characters. openssl is on every Ubuntu image worth deploying to, but a
# missing one must not be what kills an install — hence the urandom fallback.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
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

# One service at a time, retried. Compose builds all three images in parallel by
# default, which means three concurrent `npm ci` runs fighting over one uplink — and
# the way that fails is ECONNRESET halfway through a tarball, taking the whole deploy
# with it. Serial costs a few minutes on a good link; a failed build costs a redeploy.
# The npm cache mount in the Dockerfiles means a retry only re-fetches what the
# dropped connection actually lost.
build_service() {
  local svc=$1 attempt
  for attempt in 1 2 3; do
    if "${COMPOSE[@]}" build "$svc"; then
      ok "Image $svc siap"
      return 0
    fi
    if (( attempt < 3 )); then
      warn "Build $svc gagal (percobaan ${attempt}/3) — hampir selalu jaringan npm. Ulang..."
      sleep 10
    fi
  done
  fail "Build $svc gagal 3x."
  fail "Kalau errornya ECONNRESET / ETIMEDOUT / network aborted: itu koneksi ke"
  fail "registry npm, bukan kodenya. Ulangi saja — layer yang sudah jadi dipakai lagi."
  return 1
}

build_all_images() {
  local svc
  for svc in app worker setup; do
    build_service "$svc" || die "Dibatalkan di build $svc"
  done
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
