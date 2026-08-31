#!/usr/bin/env bash
#
# Aether Cosmos ByAFR — one-command VPS bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-Cosmos/main/scripts/deploy/setup.sh | bash
#
# Everything the repo's own install.sh cannot do, because it all has to happen
# before the repo exists on the machine: apt prerequisites, Docker, the firewall,
# the install directory and its ownership, the clone, and the `aether` command.
# Then it copies .env.example to .env, opens it in nano so the operator fills it in
# themselves, and hands over to ./install.sh.
#
# Deliberately standalone — it duplicates a few helpers from common.sh rather than
# sourcing it, because on a fresh VPS there is nothing to source yet.
#
# Safe to re-run: an existing checkout is updated instead of re-cloned.
#
# Overridable:
#   AETHER_REPO=<git url>   AETHER_BRANCH=<branch>   AETHER_DIR=<path>
#   AETHER_NO_FIREWALL=1    leave ufw alone
#   AETHER_NO_INSTALL=1     stop after the clone, do not run install.sh
#   AETHER_WIZARD=1         ask the questions instead of opening .env in an editor

set -euo pipefail

REPO="${AETHER_REPO:-https://github.com/AFR-projection/Aether-Cosmos.git}"
BRANCH="${AETHER_BRANCH:-main}"
DIR="${AETHER_DIR:-/opt/aether-cosmos}"
CONF_FILE="${AETHER_CONF:-/etc/aether-cosmos.conf}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

RULE="$(printf '─%.0s' $(seq 1 62))"
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*" >&2; }
die()  { fail "$*"; exit 1; }

STEP_N=0
STEP_TOTAL=6
step() {
  STEP_N=$(( STEP_N + 1 ))
  echo
  printf "${BOLD}${CYAN}[%d/%d]${NC} ${BOLD}%s${NC}\n" "$STEP_N" "$STEP_TOTAL" "$1"
  printf "${DIM}%s${NC}\n" "$RULE"
}

banner() {
  echo
  printf "${DIM}╭%s╮${NC}\n" "$RULE"
  printf "${DIM}│${NC} ${BOLD}%-60s${NC} ${DIM}│${NC}\n" "AETHER COSMOS ByAFR"
  printf "${DIM}│${NC} ${DIM}%-60s${NC} ${DIM}│${NC}\n" "One-command VPS setup"
  printf "${DIM}╰%s╯${NC}\n" "$RULE"
}

# ── Who are we, and can we escalate ───────────────────────────────────────────
# Piped through bash from curl, so $EUID is whatever ran the pipe. Both shapes are
# common on a VPS: root over ssh, or a sudo-capable user.
if [[ $EUID -eq 0 ]]; then
  SUDO=""
  RUN_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null 2>&1 || die "Neither root nor sudo — log in as root and re-run."
  SUDO="sudo"
  RUN_USER="$(id -un)"
fi
RUN_GROUP="$(id -gn "$RUN_USER")"

as_user() {
  # Files under $DIR must belong to $RUN_USER, .env above all: a root-owned .env is
  # unreadable to the person who later needs to edit it.
  #
  # Dropping privileges only happens when we are root (`sudo bash setup.sh`), and
  # $SUDO is empty there — so this cannot go through $SUDO. runuser is the util-linux
  # tool for exactly this and needs no password; sudo -u is the fallback.
  if [[ "$(id -un)" == "$RUN_USER" ]]; then
    "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- "$@"
  else
    sudo -u "$RUN_USER" "$@"
  fi
}

apt_get() {
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get "$@"
}

banner

command -v apt-get >/dev/null 2>&1 \
  || die "This bootstrap targets Ubuntu/Debian. On another distro, install git + Docker by hand and run ./install.sh."

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
step "Installing prerequisites (git, curl)"
if command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  ok "git and curl already present"
else
  apt_get update -qq
  apt_get install -y -qq git curl ca-certificates >/dev/null
  ok "git and curl installed"
fi

# ── 2. Docker ─────────────────────────────────────────────────────────────────
step "Installing Docker"
if command -v docker >/dev/null 2>&1; then
  ok "Docker already installed ($(docker --version 2>/dev/null | cut -d, -f1))"
else
  curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
  ok "Docker installed"
fi

$SUDO systemctl enable --now docker >/dev/null 2>&1 || warn "Could not enable the docker service — check 'systemctl status docker'"

if ! $SUDO docker compose version >/dev/null 2>&1; then
  die "The Docker Compose plugin is missing. Install docker-compose-plugin and re-run."
fi
ok "Docker Compose plugin ready"

# The group only takes effect in a new login shell. Until the operator reconnects,
# every deploy script falls back to `sudo docker` on its own — this is a comfort
# fix, not a requirement, so a failure here is not fatal.
if [[ "$RUN_USER" != "root" ]]; then
  if id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
    ok "$RUN_USER is already in the docker group"
  else
    $SUDO usermod -aG docker "$RUN_USER" 2>/dev/null \
      && ok "$RUN_USER added to the docker group — active after your next SSH login" \
      || warn "Could not add $RUN_USER to the docker group; the scripts will use sudo instead"
  fi
fi

# ── 3. Firewall ───────────────────────────────────────────────────────────────
step "Opening ports 80 and 443"
if [[ -n "${AETHER_NO_FIREWALL:-}" ]]; then
  warn "Skipped (AETHER_NO_FIREWALL is set)"
elif ! command -v ufw >/dev/null 2>&1; then
  warn "ufw not installed — open 80/tcp and 443/tcp in your provider's firewall"
else
  # OpenSSH first, and only then enable: the other order locks the operator out of
  # the machine they are currently typing on.
  $SUDO ufw allow OpenSSH >/dev/null 2>&1 || $SUDO ufw allow 22/tcp >/dev/null 2>&1 || true
  $SUDO ufw allow 80/tcp >/dev/null 2>&1 || true
  $SUDO ufw allow 443/tcp >/dev/null 2>&1 || true
  if $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    ok "ufw already active — 22, 80, 443 allowed"
  else
    $SUDO ufw --force enable >/dev/null 2>&1 && ok "ufw enabled — 22, 80, 443 allowed" \
      || warn "Could not enable ufw — open the ports manually"
  fi
  warn "Cloud providers have a second firewall in their console — open 80/443 there too"
fi

# ── 4. Code ───────────────────────────────────────────────────────────────────
step "Fetching the code into $DIR"
FRESH_CLONE=0
if [[ -d "$DIR/.git" ]]; then
  ok "Existing checkout found — 'aether update' is the way to move it forward"
else
  if [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null || true)" ]]; then
    die "$DIR exists, is not empty, and is not a git checkout. Move it aside and re-run."
  fi
  # /opt belongs to root: create it with sudo, then hand it to the operator before
  # cloning. Cloning as root would leave .env root-owned and uneditable.
  $SUDO mkdir -p "$DIR"
  $SUDO chown "$RUN_USER:$RUN_GROUP" "$DIR"
  as_user git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
  FRESH_CLONE=1
  ok "Cloned $BRANCH into $DIR"
fi

as_user chmod +x "$DIR/install.sh" "$DIR/deploy.sh" "$DIR/update.sh" "$DIR/bin/aether" 2>/dev/null || true
$SUDO chown -R "$RUN_USER:$RUN_GROUP" "$DIR" 2>/dev/null || true

# ── 5. The aether command ─────────────────────────────────────────────────────
step "Installing the 'aether' command"
# A copy, not a symlink: /usr/local/bin/aether then works even if $DIR is renamed,
# and it reads the directory back out of $CONF_FILE.
$SUDO install -m 0755 "$DIR/bin/aether" /usr/local/bin/aether
printf 'AETHER_DIR=%s\n' "$DIR" | $SUDO tee "$CONF_FILE" >/dev/null
$SUDO chmod 0644 "$CONF_FILE"
ok "aether installed — try 'aether help'"

# ── 6. Configuration and first deploy ─────────────────────────────────────────
step "Configuration and deploy"
cd "$DIR"

next_steps() {
  echo
  printf "${DIM}%s${NC}\n" "$RULE"
  echo -e "  ${BOLD}Next:${NC}"
  echo "    cd $DIR"
  if [[ ! -f "$DIR/.env" ]]; then
    echo "    cp .env.example .env"
    echo "    nano .env                  # fill in DATABASE_URL, R2, domain, admin"
    echo "    ./install.sh"
  else
    echo "    nano .env                  # check the contents"
    echo "    ./install.sh               # or: aether update, if it has run before"
  fi
  printf "${DIM}%s${NC}\n" "$RULE"
  echo
}

if [[ -n "${AETHER_NO_INSTALL:-}" ]]; then
  warn "Stopping before install (AETHER_NO_INSTALL is set)"
  next_steps
  exit 0
fi

if [[ ! -r /dev/tty ]]; then
  warn "No terminal available here, so .env cannot be opened for editing"
  next_steps
  exit 0
fi

if [[ -f "$DIR/.env" ]] && [[ $FRESH_CLONE -eq 0 ]]; then
  # Already configured: this is a re-run on a live box, so take the safe path that
  # backs up .env and the nginx config before touching anything.
  echo -e "  ${BOLD}Existing deployment detected${NC} — running the update path"
  bash "$DIR/scripts/deploy/update.sh"
  exit $?
fi

PUBLIC_IP="$(curl -sf --max-time 5 ifconfig.me 2>/dev/null || curl -sf --max-time 5 icanhazip.com 2>/dev/null || echo unknown)"

# ── .env, written by hand ─────────────────────────────────────────────────────
# No wizard on this path. The operator types the file themselves, which is the flow
# they can re-run, diff, and fix later with plain `nano .env` — `--wizard` stays
# available for anyone who wants the questions, but it is opt-in now.
if [[ -n "${AETHER_WIZARD:-}" ]]; then
  set +e
  bash "$DIR/install.sh" --wizard
  INSTALL_STATUS=$?
  set -e
  if [[ $EUID -eq 0 && "$RUN_USER" != "root" ]]; then
    $SUDO chown -R "$RUN_USER:$RUN_GROUP" "$DIR" 2>/dev/null || true
  fi
  exit $INSTALL_STATUS
fi

if [[ ! -f "$DIR/.env" ]]; then
  as_user cp "$DIR/.env.example" "$DIR/.env"
  as_user chmod 600 "$DIR/.env"
  ok ".env created from .env.example"
else
  ok ".env already exists — opening it for review"
fi

# ${EDITOR} if the operator has one, otherwise nano. Installed on demand: an image
# without nano would otherwise drop into vi, which is a bad surprise mid-install.
EDITOR_CMD="${EDITOR:-nano}"
if ! command -v "${EDITOR_CMD%% *}" >/dev/null 2>&1; then
  apt_get install -y -qq nano >/dev/null 2>&1 || true
  command -v nano >/dev/null 2>&1 && EDITOR_CMD="nano" || EDITOR_CMD="vi"
fi

echo
echo -e "  ${BOLD}Fill in these 7 lines in .env${NC} — the rest is already correct as-is:"
echo
echo -e "    ${BOLD}DEPLOY_DOMAIN${NC}          the domain whose A record already points to ${BOLD}${PUBLIC_IP}${NC}"
echo -e "    ${BOLD}NEXT_PUBLIC_APP_URL${NC}    https://<the same domain>"
echo -e "    ${BOLD}CERTBOT_EMAIL${NC}          your email (for SSL expiry notifications)"
echo -e "    ${BOLD}DATABASE_URL${NC}           the PostgreSQL connection string, one full line ${DIM}(…sslmode=require)${NC}"
echo -e "    ${BOLD}R2_*${NC}                   Account ID, Access Key ID, Secret, bucket, public URL"
echo -e "    ${BOLD}MASTER_USERNAME${NC}        admin username"
echo -e "    ${BOLD}MASTER_PASSWORD${NC}        admin password, min 10 characters"
echo
echo -e "  ${DIM}SESSION_SECRET is generated automatically — leave it alone.${NC}"
echo -e "  ${DIM}Every value stays in $DIR/.env on this machine and is never sent anywhere.${NC}"
if [[ "$EDITOR_CMD" == "nano" ]]; then
  echo
  echo -e "  ${DIM}In nano: edit → ${BOLD}Ctrl+O${NC}${DIM} Enter to save → ${BOLD}Ctrl+X${NC}${DIM} to exit.${NC}"
fi
echo

read -rp "  Enter to open .env in ${EDITOR_CMD} (Ctrl+C to cancel) " _ </dev/tty || true

# stdin is the curl pipe under `curl … | bash`, so the editor must be handed the real
# terminal or it exits immediately. TERM can be unset in a non-login shell; nano
# refuses to start without one.
as_user env TERM="${TERM:-xterm}" "$EDITOR_CMD" "$DIR/.env" </dev/tty >/dev/tty 2>&1 || \
  warn "Editor exited with an error — install.sh will re-check the contents of .env"

echo
ok ".env saved — continuing the deploy"

set +e
bash "$DIR/install.sh"
INSTALL_STATUS=$?
set -e

if [[ $INSTALL_STATUS -ne 0 ]]; then
  echo
  fail "Deploy stopped. Fix .env and run it again — no need to start setup from scratch:"
  echo "    cd $DIR && nano .env && ./install.sh"
fi

# `sudo curl … | sudo bash` leaves root-owned files behind; put them back before
# handing the machine over, or the operator cannot edit their own .env.
if [[ $EUID -eq 0 && "$RUN_USER" != "root" ]]; then
  $SUDO chown -R "$RUN_USER:$RUN_GROUP" "$DIR" 2>/dev/null || true
fi

exit $INSTALL_STATUS
