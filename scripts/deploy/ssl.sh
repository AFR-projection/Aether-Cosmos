#!/usr/bin/env bash
# Let's Encrypt SSL via certbot (standalone) + auto-renewal hook

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_env

setup_ssl() {
  local domain="${DEPLOY_DOMAIN:-}"
  local email="${CERTBOT_EMAIL:-admin@${domain}}"

  domain="${domain,,}"
  [[ -n "$domain" ]] || die "DEPLOY_DOMAIN tidak ditemukan"

  log "Setting up SSL for $domain"

  if ! command -v certbot >/dev/null 2>&1; then
    log "Installing certbot..."
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
  fi

  stop_nginx_container

  # Free port 80 for standalone challenge
  if ! port_free 80; then
    warn "Port 80 busy — stopping conflicting services..."
    as_root fuser -k 80/tcp 2>/dev/null || true
    sleep 2
  fi

  local cert_dir="/etc/letsencrypt/live/${domain}"
  if root_test_f "${cert_dir}/fullchain.pem"; then
    ok "Certificate already exists — renewing if needed..."
    as_root certbot renew --quiet --cert-name "$domain" 2>/dev/null || true
  else
    log "Requesting new certificate (Let's Encrypt)..."
    as_root certbot certonly --standalone \
      -d "$domain" \
      --non-interactive \
      --agree-tos \
      -m "$email" \
      --preferred-challenges http
  fi

  # root_test_f, not [[ -f ]]: this runs as the deploy user, and the directory
  # certbot just wrote into is root-only. Testing the path directly reported
  # "certificate not found" one line after certbot said it had saved it.
  root_test_f "${cert_dir}/fullchain.pem" || die "SSL certificate not found at ${cert_dir}"

  [[ -f "${cert_dir}/fullchain.pem" ]] || die "SSL certificate not found at ${cert_dir}"

  ok "SSL certificate ready"

  setup_renewal_hook "$domain"
}

setup_renewal_hook() {
  local domain=$1
  local hook="/etc/letsencrypt/renewal-hooks/deploy/aether-cosmos.sh"
  # Pre-rename name. certbot runs every file in renewal-hooks/deploy, so leaving
  # it behind means two hooks restarting nginx — and the old one points at
  # whatever $ROOT was when it was written.
  local legacy_hook="/etc/letsencrypt/renewal-hooks/deploy/storage-by-afr.sh"
  local compose_cmd="${COMPOSE[*]}"
  local hook_content="#!/bin/bash
cd \"$ROOT\"
${compose_cmd} restart nginx || true
"

  # The deploy-hooks directory ships with certbot, but a certbot installed from a
  # snap or built from source may not have it, and `tee` into a missing directory
  # fails the whole install one step from the finish line.
  as_root mkdir -p "$(dirname "$hook")"
  if [[ $EUID -eq 0 ]]; then
    echo "$hook_content" > "$hook"
  else
    echo "$hook_content" | sudo tee "$hook" >/dev/null
  fi
  as_root chmod +x "$hook"
  as_root rm -f "$legacy_hook"

  # Cron for renewal (daily check)
  local cron_line="0 3 * * * certbot renew --quiet --deploy-hook ${hook}"
  (as_root crontab -l 2>/dev/null | grep -v "certbot renew" || true; echo "$cron_line") | as_root crontab -
  ok "Auto-renewal cron configured"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  setup_ssl
fi
