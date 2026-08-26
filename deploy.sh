#!/usr/bin/env bash
# Re-deploy using existing .env (no wizard)
exec bash "$(dirname "$0")/scripts/deploy/install.sh" --skip-wizard "$@"
