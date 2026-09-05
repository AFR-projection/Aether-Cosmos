# Troubleshooting

Common failure modes and how to fix them.

---

## Local development

**`npm run dev` fails with "Cannot connect to database"**

- Confirm `DATABASE_URL` in `.env` points at a reachable PostgreSQL instance (managed
  provider, local Docker, or a dev server).
- Test the connection: `psql "$DATABASE_URL" -c "SELECT 1"` or any SQL client.
- If using a managed provider with IP restrictions, check your IP is allowed in the dashboard.

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

1. Apply the generated CORS policy from `.deploy/r2-cors.json` to your bucket:
   ```bash
   npx wrangler r2 bucket cors set <BUCKET_NAME> --file .deploy/r2-cors.json
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

`aether doctor` re-checks the configuration (`.env`, database, R2, DNS, ports) and
`aether status` reports the running services. Both name the failing item, so start
there rather than reading logs cold.

**SSL certificate missing or renewal fails**

Certificates are fetched and renewed by the installer (`install.sh`) and by
`aether update`. If the health check reports `SSL FAIL`:

1. Confirm DNS points at the VPS public IP (`dig +short <yourdomain>`).
2. Confirm port 80 is open (`ufw allow 80`).
3. Re-run `aether update` — it requests a certificate if none exists.
4. If the request still fails, check `aether logs nginx`.

The installer creates a daily Certbot renewal job, and `aether update` also asks
Certbot to renew certificates that are due. The health check fails when the local
certificate is expired or has less than 24 hours remaining.

**Container won't start**

Check the service logs:

```bash
aether logs app
aether logs worker
```

Usual causes:

- `.env` is missing or malformed — a stray quote or a missing `=` from an edit. Run
  `./install.sh --fix-env` to normalise it, or `nano .env` and fix the line.
- `DATABASE_URL` is unreachable — test it with `psql`.
- Docker permissions — the installer adds your user to the `docker` group, but the
  session must be restarted (`exit`, then SSH back in) for the group membership to
  apply. Until then the scripts fall back to `sudo docker` on their own.

**Database connection fails**

1. Verify `DATABASE_URL` in `/opt/aether-cosmos/.env` points at the right database
   project — `aether env` opens it and re-validates on save.
2. Check your provider's dashboard **IP Allow** list includes the VPS public IP.
3. Test the connection: `psql "$DATABASE_URL" -c "SELECT 1"` from the VPS.

**Worker reports `FAIL` with errors in the log**

The worker runs background jobs (thumbnails, cleanup, webhooks, archive builds,
enrichment). A `FAIL` status means the container is running but recent logs contain
`error`, `ENOTFOUND`, or `ECONNREFUSED`.

1. Read the logs:
   ```bash
   aether logs worker
   ```
2. Usual causes: Redis went away (`ECONNREFUSED`), R2 credentials are wrong
   (`ENOTFOUND` for `*.r2.cloudflarestorage.com`), or `DATABASE_URL` is stale.
3. After fixing `.env`, restart the worker:
   ```bash
   aether restart worker
   ```

**CSRF token mismatch after changing `NEXT_PUBLIC_APP_URL`**

The session cookie's `domain` and `secure` attributes are set from
`NEXT_PUBLIC_APP_URL` at build time. Changing the URL without rebuilding leaves the
old domain in the cookie, and the new origin rejects it as cross-site.

Fix: rebuild and restart:

```bash
aether deploy
```

**OTP emails stop arriving**

See [Deployment § OTP emails stop arriving](deployment.md#otp-emails-stop-arriving).

**Master password forgotten**

See [Deployment § Daily operations](deployment.md#daily-operations), table row
"Reset master password".

---

## Account backup and restore

See [Backup & Restore](backup.md) for how the feature works. These are its failure
modes.

**`/backup` answers 503, or says backup is not configured**

`BACKUP_MASTER_KEY` is unset or unusable. Nothing else in the app is affected.

1. `aether doctor` — it names the key when it is empty.
2. `aether update` fills it in (or `./install.sh` on an older deployment), generating
   64 hex characters and never touching an existing value.

**"This backup cannot be opened. Wrong recovery phrase, or the file is damaged."**

One message, three causes — deliberately, so a wrong guess learns nothing:

- the typed phrase does not belong to this archive;
- the archive came from an install with a different `BACKUP_MASTER_KEY` and no phrase
  was given (type the words shown when it was downloaded);
- the upload ended early. This one is detected separately, by comparing the bytes that
  arrived against the browser's own `Content-Length`, and is reported as a truncated
  upload rather than a bad phrase.

The `backup_restore_refused` activity-log row carries the real reason and its refusal
number. Admin → Activity Logs, or the account's own activity list.

**`/brain/graph` is empty after restoring a Brain archive**

Expected, briefly. The scored edges behind the graph are derived data: they are
recomputed after a restore, never carried in the archive. The restore response and its
audit row say "queued N of M" — `queued 0 of 1` means the worker was not running.

1. Start it: `aether restart worker` (production) or `npm run worker` (local).
2. For a brain over 1,000 memories the sweep does not cover everything in one pass —
   run `npm run brain:backfill-relate` once.

**The export refuses because of encrypted files**

End-to-end encrypted files are never included: the server holds no key to re-seal
them, and an archive it cannot read is an archive it cannot verify. Download and
decrypt those files separately.

**"A backup was started for this section recently"**

One backup per section per 10 minutes. Wait, or download the archive from the earlier
attempt — its recovery phrase is still the one that opens it.

**Clicking Download does nothing**

The download ticket lives 90 seconds and the download itself is an ordinary navigation,
so an expired ticket surfaces as a browser error rather than a message on the page.
Start the backup again; the new download comes with its own new phrase.

---

**See also:** [Getting Started](getting-started.md) · [Deployment](deployment.md) ·
[Architecture](architecture.md)
