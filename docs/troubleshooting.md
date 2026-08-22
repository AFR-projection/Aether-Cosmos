# Troubleshooting

Common failure modes and how to fix them.

---

## Local development

**`npm run dev` fails with "Cannot connect to database"**

- Confirm `DATABASE_URL` in `.env` points at a reachable PostgreSQL instance (Neon,
  local Docker, or a dev server).
- Test the connection: `psql "$DATABASE_URL" -c "SELECT 1"` or any SQL client.
- If using Neon, check your IP is allowed in the Neon dashboard.

**Redis connection error**

- Set `REDIS_DISABLED=true` in `.env` to disable Redis (pub/sub and rate limits
  fall back to in-process state).
- Or run Redis locally:
  ```bash
  docker compose -f docker/docker-compose.dev.yml up -d
  ```
  then set `REDIS_URL=redis://localhost:6379` in `.env`.

**Upload fails / R2 CORS error**

The presigned URL flow crosses origins: your dev app (`http://localhost:3000`)
sends the client to R2. If R2 CORS is missing or wrong, the browser blocks it.

1. Apply the CORS policy from `docker/r2-cors.json` to your bucket:
   ```bash
   wrangler r2 bucket cors set <BUCKET_NAME> --file docker/r2-cors.json
   ```
2. Confirm `AllowedOrigins` includes `http://localhost:3000` or your dev URL.

**Worker cannot start locally**

The worker needs Redis when `REDIS_DISABLED=false`. Two options:

1. Run Redis with `docker compose -f docker/docker-compose.dev.yml up -d` and keep
   `REDIS_DISABLED=false`.
2. Set `REDIS_DISABLED=true` and skip the worker for local work — thumbnails and
   webhooks won't run, but file operations still work.

**`tsc --noEmit` passes but `next build` fails**

TypeScript does not see files inside dot-directories (like `app/.well-known/**`).
A type error there is only caught by the build. See
[Development § Verification gates](development.md#verification-gates).

---

## Production (VPS + Docker)

**SSL certificate missing or renewal fails**

Certificates are fetched and renewed by the installer (`install.sh`) and updater
(`update.sh`). If the health check reports `SSL FAIL`:

1. Confirm DNS points at the VPS public IP (`dig +short <yourdomain>`).
2. Confirm port 80 is open (`ufw allow 80`).
3. Re-run `./update.sh` — it requests a certificate if none exists.
4. If the request still fails, check `docker compose -f docker/docker-compose.yml logs nginx`.

Let's Encrypt renews certs older than 60 days automatically on every `update.sh`.

**Container won't start**

Check the service logs:

```bash
cd /var/www/storage
docker compose -f docker/docker-compose.yml logs app --tail 100
docker compose -f docker/docker-compose.yml logs worker --tail 100
```

Usual causes:

- `.env` is missing or malformed — the installer creates it; manual edits sometimes
  introduce a stray quote or missing `=`. Run `./install.sh --fix-env` or
  `./install.sh --force-wizard` to regenerate it.
- `DATABASE_URL` is unreachable — test it with `psql`.
- Docker permissions — the installer adds your user to the `docker` group, but the
  session must be restarted (`exit`, then SSH back in) for the group membership to
  apply.

**Database connection fails**

1. Verify `DATABASE_URL` in `/var/www/storage/.env` points at the right Neon
   project.
2. Check the Neon dashboard **IP Allow** list includes the VPS public IP.
3. Test the connection: `psql "$DATABASE_URL" -c "SELECT 1"` from the VPS.

**Worker reports `FAIL` with errors in the log**

The worker runs background jobs (thumbnails, cleanup, webhooks, archive builds,
enrichment). A `FAIL` status means the container is running but recent logs contain
`error`, `ENOTFOUND`, or `ECONNREFUSED`.

1. Read the logs:
   ```bash
   docker compose -f docker/docker-compose.yml logs worker --tail 100
   ```
2. Usual causes: Redis went away (`ECONNREFUSED`), R2 credentials are wrong
   (`ENOTFOUND` for `*.r2.cloudflarestorage.com`), or `DATABASE_URL` is stale.
3. After fixing `.env`, restart the worker:
   ```bash
   docker compose -f docker/docker-compose.yml restart worker
   ```

**CSRF token mismatch after changing `NEXT_PUBLIC_APP_URL`**

The session cookie's `domain` and `secure` attributes are set from
`NEXT_PUBLIC_APP_URL` at build time. Changing the URL without rebuilding leaves the
old domain in the cookie, and the new origin rejects it as cross-site.

Fix: rebuild and restart:

```bash
docker compose -f docker/docker-compose.yml down
docker compose -f docker/docker-compose.yml build --no-cache app worker
docker compose -f docker/docker-compose.yml up -d
```

**OTP emails stop arriving**

See [Deployment § OTP emails stop arriving](deployment.md#otp-emails-stop-arriving).

**Master password forgotten**

See [Deployment § Daily operations](deployment.md#daily-operations), table row
"Reset master password".

---

**See also:** [Getting Started](getting-started.md) · [Deployment](deployment.md) ·
[Architecture](architecture.md)
