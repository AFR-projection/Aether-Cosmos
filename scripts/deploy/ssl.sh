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
    if [[ $EUID -eq 0 ]]; then
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
    else
      sudo apt-get update -qq
      DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq certbot
    fi
  fi

  stop_nginx_container

  # Free port 80 for standalone challenge
  if ! port_free 80; then
    warn "Port 80 busy — stopping conflicting services..."
    if [[ $EUID -eq 0 ]]; then
      fuser -k 80/tcp 2>/dev/null || true
    else
      sudo fuser -k 80/tcp 2>/dev/null || true
    fi
    sleep 2
  fi

  local cert_dir="/etc/letsencrypt/live/${domain}"
  if [[ -f "${cert_dir}/fullchain.pem" ]]; then
    ok "Certificate already exists — renewing if needed..."
    if [[ $EUID -eq 0 ]]; then
      certbot renew --quiet --cert-name "$domain" 2>/dev/null || true
    else
      sudo certbot renew --quiet --cert-name "$domain" 2>/dev/null || true
    fi
  else
    log "Requesting new certificate (Let's Encrypt)..."
    if [[ $EUID -eq 0 ]]; then
      certbot certonly --standalone \
        -d "$domain" \
        --non-interactive \
        --agree-tos \
        -m "$email" \
        --preferred-challenges http
    else
      sudo certbot certonly --standalone \
        -d "$domain" \
        --non-interactive \
        --agree-tos \
        -m "$email" \
        --preferred-challenges http
    fi
  fi

  [[ -f "${cert_dir}/fullchain.pem" ]] || die "SSL certificate not found at ${cert_dir}"

  ok "SSL certificate ready"

  setup_renewal_hook "$domain"
}

setup_renewal_hook() {
  local domain=$1
  local hook="/etc/letsencrypt/renewal-hooks/deploy/storage-by-afr.sh"
  local compose_cmd="${COMPOSE[*]}"
  local hook_content="#!/bin/bash
cd \"$ROOT\"
${compose_cmd} restart nginx || true
"

  if [[ $EUID -eq 0 ]]; then
    echo "$hook_content" > "$hook"
    chmod +x "$hook"
  else
    echo "$hook_content" | sudo tee "$hook" >/dev/null
    sudo chmod +x "$hook"
  fi

  # Cron for renewal (daily check)
  local cron_line="0 3 * * * certbot renew --quiet --deploy-hook ${hook}"
  if [[ $EUID -eq 0 ]]; then
    (crontab -l 2>/dev/null | grep -v "certbot renew" || true; echo "$cron_line") | crontab -
  else
    (sudo crontab -l 2>/dev/null | grep -v "certbot renew" || true; echo "$cron_line") | sudo crontab -
  fi
  ok "Auto-renewal cron configured"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  setup_ssl
fi
