# Deployment

Production deployment of Aether Cosmos ByAFR on a fresh Ubuntu VPS, from nothing to a
working HTTPS site. One command does the whole thing; everything below that command
is either an explanation of it or a way out of a specific problem.

For local development, see [Getting Started](getting-started.md).

- [Before you start](#before-you-start)
- [Install in one command](#install-in-one-command)
- [Redeploy](#redeploy)
- [The `aether` command](#the-aether-command)
- [What the installer asks for](#what-the-installer-asks-for)
- [After the first install](#after-the-first-install)
- [Troubleshooting](#troubleshooting)

---

## Before you start

### Server

| Item | Minimum |
|------|---------|
| OS | Ubuntu 22.04 or 24.04 LTS |
| RAM | 2 GB (4 GB recommended) |
| CPU | 2 vCPU |
| Disk | 20 GB SSD |
| Network | Ports **80** and **443** open in the provider's security group |

### External services (free tiers are sufficient)

| Service | Used for | Where |
|---------|----------|-------|
| Neon PostgreSQL | All metadata and Second Brain data | https://neon.tech |
| Cloudflare R2 | File objects | https://dash.cloudflare.com → R2 |
| A domain | HTTPS certificate and app URL | Your registrar's DNS panel |

The database and Redis are **external to the VPS**. The VPS runs the app, the
worker, Redis, and Nginx; it never becomes the system of record.

### One thing to do first: point the domain at the VPS

| Type | Name | Value |
|------|------|-------|
| A | `aether` (or `@`) | YOUR-VPS-IP |

Propagation takes 5–30 minutes. `ping aether.example.com` must answer with the VPS
IP before you install — Let's Encrypt verifies over HTTP, so certificate issuance
fails while DNS still points elsewhere.

---

## Install in one command

SSH into the VPS and run:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-Cosmos/main/scripts/deploy/setup.sh | bash
```

That is the whole install. It installs git and Docker, opens ports 80/443, clones
the repository to `/opt/aether-cosmos`, installs the `aether` command, and then
asks you four questions (domain, database, R2, admin account) before building and
starting everything. Expect 5–10 minutes, most of it the container build.

It is safe to re-run: an existing checkout takes the update path instead of being
cloned over.

> **`curl … | bash` runs code from the internet as it downloads.** That is a
> reasonable thing to be uneasy about. Download it, read it, then run it:
>
> ```bash
> curl -fsSLO https://raw.githubusercontent.com/AFR-projection/Aether-Cosmos/main/scripts/deploy/setup.sh
> less setup.sh
> bash setup.sh
> ```

Knobs, if the defaults do not fit:

```bash
AETHER_DIR=/srv/aether  bash setup.sh   # install somewhere else
AETHER_BRANCH=dev       bash setup.sh   # a different branch
AETHER_NO_FIREWALL=1    bash setup.sh   # leave ufw alone
AETHER_NO_INSTALL=1     bash setup.sh   # clone and stop, configure by hand
```

### Doing it by hand instead

The bootstrap is the same seven commands you would type yourself. If you would
rather see each one, run these **one line at a time**:

```bash
sudo apt update && sudo apt install -y git curl

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker

# /opt belongs to root, so hand the directory over before cloning — cloning as
# root instead would leave every file, including .env, owned by root.
sudo mkdir -p /opt/aether-cosmos
sudo chown "$USER:$USER" /opt/aether-cosmos
cd /opt/aether-cosmos

# Into "." — the URL and the destination on one line is the shape that breaks
# when a terminal wraps a pasted block, and the clone then lands in $HOME.
git clone https://github.com/AFR-projection/Aether-Cosmos.git .

./install.sh --wizard      # or: cp .env.example .env && nano .env && ./install.sh
```

Pasting that whole block at once works only if nothing wraps: a broken line turns
`git clone <url> /opt/aether-cosmos` into a clone into `$HOME`, followed by bash
trying to execute a directory.

---

## Redeploy

```bash
aether update
```

From anywhere on the VPS, as the user who installed it. It backs up `.env` and the
Nginx config, pulls the latest commit, re-validates the configuration, rebuilds the
containers, syncs the database schema, renews the certificate, and health-checks
the result — stopping at the first stage that fails, and printing which one.

**Push first.** It pulls from the Git remote, so your local work has to be on
`origin/main` before it can arrive on the server.

Rebuild without pulling — after editing `.env`, for example:

```bash
aether deploy
```

### When the update fails with "Not possible to fast-forward"

```
fatal: Not possible to fast-forward, aborting.
```

The VPS checkout has diverged from the remote — someone edited files on the server.
Three ways out, in order of preference:

**1. Force reset** — the right choice when nothing on the VPS is worth keeping:

```bash
aether update --force     # discards local changes, resets to origin, then updates
```

**2. Stash and rebase** — keeps the local changes:

```bash
cd /opt/aether-cosmos
git stash                       # set local changes aside
git fetch origin
git rebase origin/main
git stash pop                   # reapply; resolve conflicts by hand if any
aether update
```

**3. Manual reset** — same effect as option 1, done explicitly:

```bash
cd /opt/aether-cosmos
git fetch origin
git reset --hard origin/main    # discards all local changes
aether update
```

Options 1 and 3 delete uncommitted work on the server permanently. `.env` and the
Nginx config survive either way, because the update backs them up first.

---

## The `aether` command

Installed to `/usr/local/bin/aether` by the bootstrap, and it remembers where the
checkout lives (`/etc/aether-cosmos.conf`), so none of these need a `cd` first.

| Command | What it does |
|---------|--------------|
| `aether update` | Pull, back up, rebuild, sync schema, renew cert, health-check |
| `aether deploy` | Rebuild the checkout already on the VPS, without pulling |
| `aether status` | Health of every service — Redis, app, worker, Nginx, DB, SSL, email |
| `aether logs [service]` | Follow logs; `app`, `worker`, `redis`, or `nginx` |
| `aether ps` | Container list |
| `aether doctor` | Re-run every pre-flight check: `.env`, database, R2, DNS, ports |
| `aether restart [service]` | Restart one service, or all of them |
| `aether stop` / `aether start` | Stop or start the whole stack |
| `aether env` | Open `.env` in `$EDITOR`, then re-validate it |
| `aether backup` | Copy `.env` and the Nginx config into `.deploy/backups/` |
| `aether shell [service]` | Shell inside a container (default `app`) |
| `aether version` | Version, install directory, domain, deployed commit |

The repository scripts it wraps still work directly — `./install.sh`,
`./deploy.sh`, `./update.sh` — and `./bin/aether` runs from a checkout without
being installed. `aether` is the surface worth remembering.

---

## What the installer asks for

Four things. Have them open in a browser tab before you start.

**1. Domain and email** — a bare hostname, and an address Let's Encrypt can warn
about expiry.

**2. `DATABASE_URL`** — copy it from the Neon dashboard exactly as given.

**3. R2 credentials** — account ID, access key ID, secret access key, bucket name,
and the bucket's public URL.

**4. Admin account** — username and a password of at least 10 characters. This
becomes the master account.

The wizard writes them to `/opt/aether-cosmos/.env` and generates `SESSION_SECRET`
itself. Nothing leaves the machine.

### Or write `.env` yourself

```bash
cd /opt/aether-cosmos
cp .env.example .env
nano .env
./install.sh
```

`cp` failing with `cannot stat '.env.example'` means the clone did not land
here — check `ls` before blaming the file. `nano` then happily opens a new empty
`.env`, which is why an empty editor is the symptom of a failed clone rather
than a missing template.

A production `.env` looks like this:

```env
NODE_ENV=production
DEPLOY_DOMAIN=aether.example.com
CERTBOT_EMAIL=admin@aether.example.com

DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=aether-cosmos
R2_PUBLIC_URL=https://pub-xxxx.r2.dev

MASTER_USERNAME=admin
MASTER_PASSWORD=password-at-least-10-characters
SESSION_SECRET=random-64-character-hex

NEXT_PUBLIC_APP_URL=https://aether.example.com
COOKIE_SECURE=true
HSTS_ENABLED=true
REDIS_URL=redis://redis:6379
REDIS_DISABLED=false
```

> **`DATABASE_URL` must be one unbroken line** exactly as Neon gives it. A value
> wrapped by the editor into `...?sslmode>` is the single most common cause of a
> failed deploy.

> **`DEPLOY_DOMAIN` is a bare hostname**, no `https://` and no trailing path.
> `NEXT_PUBLIC_APP_URL` is the one that carries the scheme. With a scheme in
> `DEPLOY_DOMAIN`, `validate.sh` rejects the format, and if it got past there
> Nginx would emit `server_name https://…`, certbot would be handed
> `-d https://…`, and the health check would build `https://https://…`.

Every variable, including the optional ones, is documented in
[Getting Started § Environment variables](getting-started.md#environment-variables-reference).

Everything settable from the running app — upload limits, presigned URL lifetime,
rate limits, login lockout — lives in **Admin → Settings**, not in `.env`.

### What the installer does, in order

1. validates `.env` formatting and reachability of the database and R2,
2. requests a Let's Encrypt certificate,
3. generates the Nginx configuration,
4. builds and starts the containers (app, worker, redis, nginx),
5. syncs the database schema and bootstraps the master admin,
6. health-checks every service.

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
[Add an email sender](#3-add-an-email-sender-otp-delivery).

---

## After the first install

Three things the installer cannot do for you.

### 1. Configure R2 CORS

Browser uploads go straight to R2, so the bucket must accept your origin.
Uploads fail with a CORS error until this is done.

1. Edit `docker/r2-cors.json` and replace `your-domain.com` with your domain.
2. Apply it — Cloudflare Dashboard → R2 → your bucket → Settings → CORS, or:

```bash
wrangler r2 bucket cors set YOUR-BUCKET-NAME --file docker/r2-cors.json
```

### 2. Allowlist the VPS in Neon (if required)

Neon projects with IP restrictions enabled reject the VPS until it is listed:
Neon Dashboard → Project → Settings → **IP Allow** → add the VPS public IP. The
installer prints the IP it connected from when the check fails.

### 3. Add an email sender (OTP delivery)

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

### Backups

Automatic, on every `aether update`: `.env` and the generated Nginx config, under
`.deploy/backups/`. On demand: `aether backup`.

Worth doing yourself:

- keep an offline copy of `.env` — it holds every secret, and nothing else does;
- use Neon's built-in backups or branches for the database;
- R2 objects are already durable on Cloudflare's side.

### Why schema updates need no manual step

- PostgreSQL (Neon) and Redis are **external services**. The VPS only connects to
  them, and it connects to the same database used during development.
- `aether update` syncs the schema with **`npm run db:push`**, not
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

## Troubleshooting

Start with `aether doctor` — it re-runs every pre-flight check (`.env` format,
database, R2, DNS, ports) and names what is wrong. `aether status` reports the
health of the running services.

### Login fails or returns a CSRF error

- Access the site over **HTTPS**, not the raw IP or `http://`.
- `NEXT_PUBLIC_APP_URL` in `.env` must be exactly `https://your-domain.com`.
- That value is baked in at build time — rebuild after changing it: `aether deploy`.

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
- Verify with `aether doctor`.

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
  [Configure R2 CORS](#1-configure-r2-cors)).
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
aether logs worker
```

Usual causes: Redis is down, `DATABASE_URL` is wrong, or the R2 credentials are
invalid.

### OTP emails stop arriving

Delivery is plain SMTP through the Gmail senders in **Admin → Email**. There is no
session or socket to restore — a stalled pool is always a sender problem.

1. Check the health line: `aether status` reports `Email OK` with the
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
| `scripts/deploy/setup.sh` | The one-command bootstrap; the only file that runs before the clone |
| `bin/aether` | The `aether` command, copied to `/usr/local/bin` |
| `install.sh` | Install entry point |
| `update.sh` | Safe update path (`aether update`) |
| `deploy.sh` | Rebuild without pulling (`aether deploy`) |
| `.env` | All secrets and configuration |
| `docker/docker-compose.yml` | Container topology |
| `docker/generated/nginx.conf` | Generated Nginx config — do not edit by hand |
| `scripts/deploy/` | Modular deploy steps |
| `.deploy/backups/` | Automatic `.env` and Nginx backups |
| `/etc/aether-cosmos.conf` | Where `aether` looks up the install directory |

---

**See also:** [Getting Started](getting-started.md) ·
[Architecture](architecture.md) · [Troubleshooting](troubleshooting.md)









