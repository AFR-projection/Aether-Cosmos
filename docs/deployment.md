# Deployment

Production deployment of Aether Cosmos ByAFR on a fresh Ubuntu VPS, from nothing to a
working HTTPS site. Written to be followable without prior DevOps experience: the
whole path is a fresh VPS + a domain + `./install.sh`.

For local development, see [Getting Started](getting-started.md).

- [Already installed? Update in three lines](#updating-an-existing-deployment)
- [First install](#first-install)
- [Daily operations](#daily-operations)
- [Troubleshooting](#troubleshooting)

---

## Requirements

### Server

| Item | Minimum |
|------|---------|
| OS | Ubuntu 22.04 or 24.04 LTS |
| RAM | 2 GB (4 GB recommended) |
| CPU | 2 vCPU |
| Disk | 20 GB SSD |
| Network | Ports **80** and **443** open in both the OS firewall and the provider's security group |

### External services (free tiers are sufficient)

| Service | Used for | Where |
|---------|----------|-------|
| Neon PostgreSQL | All metadata and Second Brain data | https://neon.tech |
| Cloudflare R2 | File objects | https://dash.cloudflare.com → R2 |
| A domain | HTTPS certificate and app URL | Your registrar's DNS panel |

The database and Redis are **external to the VPS**. The VPS runs the app, the
worker, Redis, and Nginx; it never becomes the system of record.

---

## First install

The whole sequence, if you already know what goes in `.env`:

```bash
ssh ubuntu@YOUR-VPS-IP
git clone <repo-url> /opt/storage-by-afr
cd /opt/storage-by-afr
chmod +x install.sh deploy.sh update.sh

cp .env.example .env
nano .env          # DATABASE_URL, R2 credentials, domain — see step 3

./install.sh
```

The steps below explain each part.

### Step 1 — Point the domain at the VPS

In your DNS panel:

| Type | Name | Value |
|------|------|-------|
| A | `storage` (or `@`) | YOUR-VPS-IP |

Propagation takes 5–30 minutes. Verify before continuing — `ping storage.example.com`
must resolve to the VPS IP. Certificate issuance fails if it does not.

### Step 2 — Open the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Cloud providers (AWS, Tencent, GCP, …) have a second firewall in the console. Open
ports 80 and 443 in that **security group** as well, or the certificate request
will time out even though `ufw` looks correct.

### Step 3 — Write `.env` and install

```bash
ssh ubuntu@YOUR-VPS-IP
sudo apt update && sudo apt install -y git curl

git clone <repo-url> /opt/storage-by-afr
cd /opt/storage-by-afr
chmod +x install.sh deploy.sh update.sh

cp .env.example .env
nano .env
```

A production `.env` looks like this:

```env
NODE_ENV=production
DEPLOY_DOMAIN=storage.example.com
CERTBOT_EMAIL=admin@storage.example.com

DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=strogebyafr
R2_PUBLIC_URL=https://pub-xxxx.r2.dev

MASTER_USERNAME=admin
MASTER_PASSWORD=password-at-least-10-characters
SESSION_SECRET=random-64-character-hex

NEXT_PUBLIC_APP_URL=https://storage.example.com
COOKIE_SECURE=true
HSTS_ENABLED=true
REDIS_URL=redis://redis:6379
REDIS_DISABLED=false
```

> **`DATABASE_URL` must be one unbroken line** exactly as Neon gives it. A value
> wrapped by the editor into `...?sslmode>` is the single most common cause of a
> failed deploy.

Every variable, including the optional ones, is documented in
[Getting Started § Environment variables](getting-started.md#environment-variables-reference).

Then run the installer:

```bash
./install.sh
```

It performs, in order:

1. validates `.env` formatting,
2. requests a Let's Encrypt certificate,
3. generates the Nginx configuration,
4. builds and starts the containers (app, worker, redis, nginx),
5. syncs the database schema and bootstraps the master admin,
6. health-checks every service.

An interactive wizard is available instead of hand-editing `.env`:
`./install.sh --wizard`.

A successful run ends with a health report; the labels are `Redis`, `App`,
`Worker`, `Nginx`, `Database`, `SSL`, and `Email`:

```
  Redis          OK   running
  App            OK   HTTP responding
  Worker         OK   running
  Nginx          OK   running
  Database       OK   connected
  SSL            OK   valid until Nov 12 08:14:00 2026 GMT
  Email          WARN no verified sender — add one in Admin → Email
  All services healthy
```

`Email` warns rather than fails on a fresh install — see
[Step 6](#step-6--add-an-email-sender-otp-delivery).

### Step 4 — Configure R2 CORS

Browser uploads go straight to R2, so the bucket must accept your origin.
Uploads fail with a CORS error until this is done.

1. Edit `docker/r2-cors.json` and replace `your-domain.com` with your domain.
2. Apply it — Cloudflare Dashboard → R2 → your bucket → Settings → CORS, or:

```bash
wrangler r2 bucket cors set YOUR-BUCKET-NAME --file docker/r2-cors.json
```

### Step 5 — Allowlist the VPS in Neon (if required)

Neon projects with IP restrictions enabled reject the VPS until it is listed:
Neon Dashboard → Project → Settings → **IP Allow** → add the VPS public IP. The
installer prints the IP it connected from when the check fails.

### Step 6 — Add an email sender (OTP delivery)

Registration codes, verification codes, and notifications go out over SMTP using
Gmail senders you add yourself. Until at least one sender is verified, the health
check reports `Email WARN` and no OTP can be delivered.

1. Log in as the master user → **Admin → Email**.
2. **Add sender** → Gmail address + a Gmail **App Password** (not the account
   password). The App Password is stored encrypted (AES-256-GCM, key derived from
   `SESSION_SECRET`).
3. Verify the sender; its status must read `ok`.
4. Register a test user and confirm the code arrives.

More than one sender is worth adding. The router spreads volume across the pool:
each sender has a rolling 24-hour cap (`emailDailyLimitPerSender`, default 400), a
sender is rested after `emailFailureThreshold` consecutive failures (default 3)
for `emailCooldownMinutes` (default 30), and among equally eligible senders the
least recently used goes first. All of that accounting lives in the database, so
it survives restarts.

> Rotating `SESSION_SECRET` makes every stored App Password unreadable. Re-enter
> them from Admin → Email afterwards.

---

## Updating an existing deployment

Three lines, no extra steps:

```bash
cd /opt/storage-by-afr
git pull            # fetch the latest code
./update.sh         # backup → validate → rebuild → sync schema → health check
```

`./update.sh` runs `git pull` itself, so this is equivalent:

```bash
cd /opt/storage-by-afr && ./update.sh
```

It backs up `.env` and the Nginx config, rebuilds the containers, syncs the
database schema, renews the certificate, and health-checks at the end. If any
stage fails it stops and reports which one.

**Push first.** `./update.sh` pulls from the Git remote, so commit and push your
local changes before running it on the VPS.

Backups it writes before touching anything:

- `.deploy/backups/.env.TIMESTAMP`
- `.deploy/backups/nginx.TIMESTAMP.conf`

### When the update fails with "Not possible to fast-forward"

```
fatal: Not possible to fast-forward, aborting.
```

The VPS checkout has diverged from the remote — someone edited files on the server.
Three ways out, in order of preference:

**1. Force reset** — the right choice when nothing on the VPS is worth keeping:

```bash
./update.sh --force      # discards local changes, resets to origin, then updates
```

**2. Stash and rebase** — keeps the local changes:

```bash
cd /opt/storage-by-afr
git stash                       # set local changes aside
git fetch origin
git rebase origin/main          # or origin/master
git stash pop                   # reapply; resolve conflicts by hand if any
./update.sh
```

**3. Manual reset** — same effect as option 1, done explicitly:

```bash
cd /opt/storage-by-afr
git fetch origin
git reset --hard origin/main    # discards all local changes
./update.sh
```

Options 1 and 3 delete uncommitted work on the server permanently. `.env` and the
Nginx config survive either way, because `./update.sh` backs them up first.

### Why schema updates need no manual step

- PostgreSQL (Neon) and Redis are **external services**. The VPS only connects to
  them, and it connects to the same database used during development.
- `./update.sh` syncs the schema with **`npm run db:push`**, not
  `drizzle-kit migrate`. `db:push` compares `lib/db/schema.ts` against the live
  database and applies only the difference; when they already match it is a no-op.
- Schema changes already applied to Neon during development (new columns, indexes,
  full-text search columns) are therefore live the moment the VPS connects. A
  redeploy only rebuilds the application code.

> **Renaming a column is the exception.** `db:push` handles added columns and
> indexes safely, but a rename it has not seen yet looks like "drop the old column,
> create a new one", which destroys the data in it. Apply renames to Neon **before**
> redeploying, so `db:push` sees a schema that already matches. Keep the order
> "apply to Neon first, then redeploy" and data is never at risk.

---

## Daily operations

| Command | What it does |
|---------|--------------|
| `./install.sh` | First-time install (optionally with `--wizard`) |
| `./update.sh` | Update: pull, back up, rebuild, sync schema, health check |
| `./deploy.sh` | Rebuild from the code already on the VPS, without pulling |
| `npm run deploy:logs` | Tail container logs |
| `npm run deploy:health` | Report the status of every service |

Use `./update.sh` to move to a newer version; use `./deploy.sh` only to rebuild
the current checkout, for example after editing `.env`.

### Backups

Automatic, on every `./update.sh`: `.env` and the generated Nginx config, under
`.deploy/backups/`.

Worth doing yourself:

- keep an offline copy of `.env` — it holds every secret, and nothing else does;
- use Neon's built-in backups or branches for the database;
- R2 objects are already durable on Cloudflare's side.

---

## Troubleshooting

### Login fails or returns a CSRF error

- Access the site over **HTTPS**, not the raw IP or `http://`.
- `NEXT_PUBLIC_APP_URL` in `.env` must be exactly `https://your-domain.com`.
- That value is baked in at build time — rebuild after changing it: `./deploy.sh`.

### Certificate issuance fails

- DNS is not pointing at the VPS yet → fix the A record and wait for propagation.
- Port 80 is blocked → open it in `ufw` **and** the provider's security group.
- Retry on its own: `sudo bash scripts/deploy/ssl.sh`.

### Docker permission denied

```bash
sudo usermod -aG docker $USER
newgrp docker
# or simply:
sudo ./install.sh
```

The installer falls back to `sudo docker` when it has to.

### Database connection fails

- Re-copy `DATABASE_URL` from the Neon dashboard — it must be **one unbroken line**.
- Neon → Project Settings → **IP Allow** → add the VPS IP (printed by the installer
  when the connection is refused), or disable the restriction temporarily.
- Verify with `npm run deploy:health`.

### `.env` is malformed (stray quote or newline inside a value)

An older version of the wizard could produce:

```env
R2_SECRET_ACCESS_KEY="
acf230cb..."
```

Repair it in place, or regenerate it:

```bash
./install.sh --fix-env         # repair
./install.sh --force-wizard    # start over from the wizard
```

### Uploads fail with a CORS error

- The R2 bucket CORS policy must list your HTTPS origin (see
  [Step 4](#step-4--configure-r2-cors)).
- `NEXT_PUBLIC_APP_URL` must match the URL in the browser's address bar.

### Encrypted files ask for a passphrase and are excluded from ZIPs

Working as designed, not a bug. Files uploaded with encryption enabled are
encrypted in the browser before they reach the server:

- **Downloading** one prompts for the passphrase, decrypts in the browser, and
  saves the original file. The passphrase is never sent to the server.
- **ZIP and batch downloads skip encrypted files** — the server holds no
  passphrase, so it cannot put the plaintext into an archive. Download them
  individually.
- If the passphrase is lost the file is unrecoverable by anyone, including an
  administrator. That is the point of end-to-end encryption.

### The worker reports FAIL in the health check

```bash
docker compose -f docker/docker-compose.yml logs worker --tail 50
```

Usual causes: Redis is down, `DATABASE_URL` is wrong, or the R2 credentials are
invalid.

### OTP emails stop arriving

Delivery is plain SMTP through the Gmail senders in **Admin → Email**. There is no
session or socket to restore — a stalled pool is always a sender problem.

1. Check the health line: `npm run deploy:health` reports `Email OK` with the
   number of ready senders, or `WARN` when none is verified.
2. **Admin → Email** shows each sender's status, last error, daily count, and
   cooldown. A sender on cooldown resumes automatically; one marked failed needs
   attention.
3. Usual causes: the Gmail App Password was revoked, 2-Step Verification was turned
   off on that Google account (which invalidates App Passwords), or the sender hit
   its rolling 24-hour cap.
4. After rotating `SESSION_SECRET`, every stored App Password is unreadable —
   re-enter them.
5. `/api/admin/email/logs` and the Admin → Email log view record what was
   attempted and which sender was chosen.

### Reset the master password

```bash
docker compose -f docker/docker-compose.yml --profile setup run --rm setup
# or, on the host with .env present:
npm run reset-master-password
```

> Changing `SESSION_SECRET` is not a password reset and is not free: stored Gmail
> app passwords and TOTP secrets are encrypted with it and become unreadable.
> Re-enter them from the admin panel afterwards.

---

## Deployment architecture

```
Internet → Nginx (:443, TLS) → Next.js app (:3000)
                             ↘ Redis → Worker (thumbnails, cleanup, webhooks)

External: Neon PostgreSQL · Cloudflare R2 · Gmail SMTP (senders you add)
Volumes:  redis_data (the only one)
Certs:    Let's Encrypt, renewed automatically
```

If Redis or R2 is unavailable the app degrades — background jobs queue up, file
bodies are unreachable — but PostgreSQL remains the single source of truth for
metadata and Second Brain content.

## Files that matter

| Path | Purpose |
|------|---------|
| `install.sh` | Install entry point |
| `update.sh` | Safe update path |
| `deploy.sh` | Rebuild without pulling |
| `.env` | All secrets and configuration |
| `docker/docker-compose.yml` | Container topology |
| `docker/generated/nginx.conf` | Generated Nginx config — do not edit by hand |
| `scripts/deploy/` | Modular deploy steps |
| `.deploy/backups/` | Automatic `.env` and Nginx backups |

`scripts/vps-deploy.sh` is a legacy script kept for reference; use `./install.sh`.

---

**See also:** [Getting Started](getting-started.md) ·
[Architecture](architecture.md) · [Troubleshooting](troubleshooting.md)









