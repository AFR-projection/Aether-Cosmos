#!/bin/sh
# Drop root → the unprivileged app user before starting the server.
set -eu

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec nextjs "$@"
fi

# Fallback when su-exec is unavailable (should not happen in our image).
exec "$@"
