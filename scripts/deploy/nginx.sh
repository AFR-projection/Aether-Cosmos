#!/usr/bin/env bash
# Generate nginx.conf from template + domain

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_env

generate_nginx() {
  local domain="${DEPLOY_DOMAIN:-}"
  [[ -n "$domain" ]] || die "DEPLOY_DOMAIN missing"
  domain="${domain,,}"

  local cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
  local key="/etc/letsencrypt/live/${domain}/privkey.pem"

  [[ -f "$NGINX_TEMPLATE" ]] || die "Template not found: $NGINX_TEMPLATE"
  root_test_f "$cert" || die "SSL cert not found at $cert — run ssl.sh first"

  command -v envsubst >/dev/null 2>&1 || {
    log "Installing gettext-base (envsubst)..."
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gettext-base
  }

  mkdir -p "$(dirname "$NGINX_GEN")"
  mkdir -p "$ROOT/docker/certbot-webroot"

  export DOMAIN="$domain"
  export SSL_CERT="$cert"
  export SSL_KEY="$key"

  envsubst '${DOMAIN} ${SSL_CERT} ${SSL_KEY}' < "$NGINX_TEMPLATE" > "$NGINX_GEN"
  ok "Nginx config generated: $NGINX_GEN"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  generate_nginx
fi
