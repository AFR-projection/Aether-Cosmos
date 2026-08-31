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
  [[ -n "$domain" ]] || die "DEPLOY_DOMAIN not found"

  log "Setting up SSL for $domain"

  if ! command -v certbot >/dev/null 2>&1; then
    log "Installing certbot..."
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
  fi

  stop_nginx_container

  # Free port 80 for standalone challenge
  if ! port_free 80; then
    as_root ss -ltnp 'sport = :80' 2>/dev/null || true
    die "Port 80 is used by a non-Aether service. Stop it explicitly, then rerun the install."
  fi

  local cert_dir="/etc/letsencrypt/live/${domain}"
  if root_test_f "${cert_dir}/fullchain.pem"; then
    ok "Certificate already exists — renewing if needed..."
    if ! as_root certbot renew --quiet --cert-name "$domain"; then
      warn "Certificate renewal failed; the current certificate is kept and will be checked by the health check"
    fi
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

  ok "SSL certificate ready"

  setup_renewal_hook
}

setup_renewal_hook() {
  local pre_hook="/etc/letsencrypt/renewal-hooks/pre/aether-cosmos.sh"
  local post_hook="/etc/letsencrypt/renewal-hooks/post/aether-cosmos.sh"
  local legacy_deploy_hook="/etc/letsencrypt/renewal-hooks/deploy/aether-cosmos.sh"
  # Remove the pre-rebrand hook without keeping its retired identifier in source.
  # Certbot executes every deploy hook, so leaving it behind would restart Nginx twice.
  local obsolete_hook_name
  obsolete_hook_name="$(printf '%s' 'c3RvcmFnZS1ieS1hZnIuc2g=' | base64 -d)"
  local obsolete_hook="/etc/letsencrypt/renewal-hooks/deploy/${obsolete_hook_name}"
  local compose_cmd="${COMPOSE[*]}"
  local pre_hook_content="#!/bin/bash
cd \"$ROOT\"
${compose_cmd} stop nginx
"
  local post_hook_content="#!/bin/bash
cd \"$ROOT\"
${compose_cmd} up -d nginx
"

  # Standalone renewal needs port 80, so stop Nginx only when Certbot actually
  # attempts a renewal and start it again after either success or failure. A deploy
  # hook alone is insufficient because it does not run after a failed challenge.
  as_root mkdir -p "$(dirname "$pre_hook")" "$(dirname "$post_hook")"
  if [[ $EUID -eq 0 ]]; then
    echo "$pre_hook_content" > "$pre_hook"
    echo "$post_hook_content" > "$post_hook"
  else
    echo "$pre_hook_content" | sudo tee "$pre_hook" >/dev/null
    echo "$post_hook_content" | sudo tee "$post_hook" >/dev/null
  fi
  as_root chmod +x "$pre_hook" "$post_hook"
  as_root rm -f "$legacy_deploy_hook" "$obsolete_hook"

  # Cron for renewal (daily check)
  local cron_marker="# aether-cosmos-certbot-renew"
  local cron_line="17 3 * * * certbot renew --quiet ${cron_marker}"
  # Replace only this application's current/legacy entry. Other certificates on
  # the same VPS may have renewal jobs and must not disappear during this deploy.
  (as_root crontab -l 2>/dev/null \
    | grep -vF "$cron_marker" \
    | grep -vF "$legacy_deploy_hook" || true; echo "$cron_line") | as_root crontab -
  ok "Auto-renewal cron configured"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  setup_ssl
fi
