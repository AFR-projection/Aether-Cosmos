# Deployment

Production deployment of Aether Cosmos ByAFR on a fresh Ubuntu VPS, from an empty
server to a working HTTPS site.

For local development, see [Getting Started](getting-started.md).

- [Quick start production](#quick-start-production)
- [What the installer does](#what-the-installer-does)
- [Redeploy](#redeploy)
- [The `aether` command](#the-aether-command)
- [What you fill into `.env`](#what-you-fill-into-env)
- [After the first install](#after-the-first-install)
- [Troubleshooting](#troubleshooting)

---

## Quick start production

### 1. Prepare the VPS

| Item | Minimum |
|------|---------|
| OS | Ubuntu 22.04 or 24.04 LTS |
| RAM | 2 GB (4 GB recommended) |
| CPU | 2 vCPU |
| Disk | 20 GB SSD |
| Network | Ports **80** and **443** open in the provider's security group |

Use a fresh Ubuntu VPS. Open inbound TCP ports **22**, **80**, and **443** in the
hosting provider's firewall/security group before continuing.

### 2. Prepare the domain, database, and object storage

| Service | Used for | Where |
|---------|----------|-------|
| PostgreSQL + pgvector | All metadata and Second Brain data | A dedicated production database at a provider that supports the `vector` extension |
| Cloudflare R2 | File objects | https://dash.cloudflare.com → R2 |
| A domain | HTTPS certificate and app URL | Your registrar's DNS panel |

Have these values ready before connecting to the VPS:

- the complete PostgreSQL `DATABASE_URL`, on one line and containing
  `sslmode=require` (the installer enables `pgvector` automatically);
- the R2 Account ID, Access Key ID, Secret Access Key, bucket name, and public URL;
- the production domain and an email address for Let's Encrypt.

If the PostgreSQL provider uses an IP allowlist, add the VPS public IP before
running the installer. The validation step prints that IP when access is refused.

The PostgreSQL database and R2 bucket are external. The VPS runs the app, worker,
Redis, and Nginx.

Point the domain at the VPS:

| Type | Name | Value |
|------|------|-------|
| A | `aether` (or `@`) | YOUR-VPS-IP |

Wait for propagation. `ping aether.example.com` or `dig +short
aether.example.com` must return the VPS IP before installation because Let's
Encrypt validates the domain over HTTP.

### 3. Prepare the install directory

SSH into the VPS as a normal sudo-capable user, then run these commands one line
at a time:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates

sudo mkdir -p /opt/aether-cosmos
sudo chown "$USER:$USER" /opt/aether-cosmos
cd /opt/aether-cosmos
```

Do not install Docker with `get.docker.com` first. The Aether bootstrap installs
Docker Engine and Compose from Docker's official Ubuntu apt repository.

### 4. Run the first-time installer

While still inside `/opt/aether-cosmos`, run:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-Cosmos/main/scripts/deploy/setup.sh | bash
```

The installer opens `/opt/aether-cosmos/.env` in `nano`. Fill in the domain,
PostgreSQL, R2, and master admin values, then save with **Ctrl+O**, **Enter**, and
exit with **Ctrl+X**. Leave `SESSION_SECRET` unchanged; it is generated
automatically.

The remaining work is automatic: Docker and Compose installation, firewall rules,
repository clone, HTTPS certificate, Nginx configuration, container builds,
database schema sync, master account bootstrap, service startup, and health checks.
Expect roughly 5–15 minutes depending on VPS and network speed.

The installation is complete only when the final report says:

```text
All services healthy
```

Then open `https://your-domain.com` and sign in with `MASTER_USERNAME` and
`MASTER_PASSWORD` from `.env`.

If the installer stops, nothing needs to be deleted or restarted from zero. Fix
the value it names and run:

```bash
cd /opt/aether-cosmos
nano .env
./install.sh
```

Before testing uploads, apply the generated R2 CORS policy. Add a Gmail sender if
users need OTP email. Those are external account settings and cannot be completed
by the VPS installer; see [After the first install](#after-the-first-install).

---

## What the installer does

You write `.env` yourself, so you can re-open it with `nano .env` and re-run
`./install.sh` as many times as it takes — nothing is hidden in a wizard's state.
`SESSION_SECRET` is the one value you leave alone: the install generates it.

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
AETHER_WIZARD=1         bash setup.sh   # answer prompts instead of editing .env
```

### Manual installation instead

The bootstrap performs the same operations you would do yourself. If you would
rather see each one, run these **one line at a time**:

```bash
sudo apt update && sudo apt install -y git curl ca-certificates

# Docker's official apt repository (Ubuntu 22.04/24.04)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER" && newgrp docker

# /opt belongs to root, so hand the directory over before cloning — cloning as
# root instead would leave every file, including .env, owned by root.
sudo mkdir -p /opt/aether-cosmos
sudo chown "$USER:$USER" /opt/aether-cosmos
cd /opt/aether-cosmos

# Into "." — the URL and the destination on one line is the shape that breaks
# when a terminal wraps a pasted block, and the clone then lands in $HOME.
git clone https://github.com/AFR-projection/Aether-Cosmos.git .

cp .env.example .env
nano .env                  # domain, DATABASE_URL, R2, admin — leave SESSION_SECRET
./install.sh
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

### When the update refuses local changes or cannot fast-forward

```
Not possible to fast-forward safely; no local commit was discarded.
```

The VPS checkout has local edits or commits that are not on the remote. A normal
update stops without stashing, rebasing, or deleting them. Three ways out, in order
of preference:

**1. Force reset** — the right choice when nothing on the VPS is worth keeping:

```bash
aether update --force     # discards tracked edits/local commits, then updates
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

Options 1 and 3 delete tracked edits and local commits on the server permanently;
untracked files are left alone. `.env` and the generated Nginx config survive
either way and are also backed up before Git is touched.

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
| `aether reset-password` | Reset the master password from `MASTER_PASSWORD` in `.env` |
| `aether shell [service]` | Shell inside a container (default `app`) |
| `aether version` | Version, install directory, domain, deployed commit |

The repository scripts it wraps still work directly — `./install.sh`,
`./deploy.sh`, `./update.sh` — and `./bin/aether` runs from a checkout without
being installed. `aether` is the surface worth remembering.

---

## What you fill into `.env`

Four things. Have them open in a browser tab before you start.

**1. Domain and email** — `DEPLOY_DOMAIN` (a bare hostname), `NEXT_PUBLIC_APP_URL`
(`https://` + that hostname), and `CERTBOT_EMAIL`, an address Let's Encrypt can warn
about expiry.

**2. `DATABASE_URL`** — copy it from your PostgreSQL provider dashboard exactly as
given on one line. It must include `sslmode=require`; keep any additional parameters
the provider adds after it.

**3. R2 credentials** — account ID, access key ID, secret access key, bucket name,
and the bucket's public URL. The account ID and access key ID are 32 hex characters,
the secret is 64 — the install warns when a length looks wrong, because pasting the
access key ID into both fields is the usual mistake.

**4. Admin account** — a 3–50 character username and a password containing 6–128
characters. This becomes the master account.

Everything else in `.env.example` is already correct. `SESSION_SECRET` is generated
for you when it is still the placeholder, and `NEXT_PUBLIC_APP_URL` /
`DEPLOY_DOMAIN` are derived from each other when only one is set. Nothing leaves the
machine.

The bootstrap opens the file for you, but the sequence by hand is the same:

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

### If the install stops at validation

Nothing is lost and there is no need to start over. Fix the line it named and run
the same command again:

```bash
cd /opt/aether-cosmos
nano .env
./install.sh
```

`masih nilai contoh dari .env.example` means that key is still the template value.
`aether doctor` runs the same checks on their own, without building anything.

A production `.env` looks like this:

```env
NODE_ENV=production
DEPLOY_DOMAIN=aether.example.com
CERTBOT_EMAIL=admin@aether.example.com

DATABASE_URL=postgresql://user:pass@host:port/database?sslmode=require

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=aether-cosmos
R2_PUBLIC_URL=https://pub-xxxx.r2.dev

MASTER_USERNAME=admin
MASTER_PASSWORD=ReplaceMe-Strong-2026!
SESSION_SECRET=random-64-character-hex

NEXT_PUBLIC_APP_URL=https://aether.example.com
COOKIE_SECURE=true
HSTS_ENABLED=true
REDIS_URL=redis://redis:6379
REDIS_DISABLED=false
```

> **`DATABASE_URL` must be one unbroken line** exactly as your provider gives it. A value
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

### Install stages, in order

1. validates `.env` formatting and proves the database is reachable,
2. requests a Let's Encrypt certificate,
3. generates the Nginx configuration,
4. builds the images and starts Redis,
5. verifies R2 through the application's AWS SDK, enables pgvector, syncs the
   database schema, bootstraps the master admin, then starts the app, worker, and
   Nginx,
6. health-checks every service.

A successful run ends with a health report; the labels are `Redis`, `App`,
`Worker`, `Nginx`, `Database`, `R2`, `SSL`, and `Email`:

```
  Redis          OK   PONG
  App            OK   HTTP responding
  Worker         OK   running
  Nginx          OK   HTTPS responding
  Database       OK   connected
  R2             OK   bucket accessible
  SSL            OK   valid until Nov 12 08:14:00 2026 GMT
  Email          WARN no verified sender — add one in Admin → Email
  All services healthy
```

`Email` warns rather than fails on a fresh install — see
[Add an email sender](#2-add-an-email-sender-otp-delivery).

---

## After the first install

Two external account settings remain after the VPS is healthy.

### 1. Configure R2 CORS

Browser uploads go straight to R2, so the bucket must accept your origin.
Uploads fail with a CORS error until this is done.

The installer already writes a production-only policy containing your domain to
`.deploy/r2-cors.json`. Apply it through Cloudflare Dashboard → R2 → your bucket →
Settings → CORS, or from `/opt/aether-cosmos`:

```bash
npx wrangler r2 bucket cors set YOUR-BUCKET-NAME --file .deploy/r2-cors.json
```

### 2. Add an email sender (OTP delivery)

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

### Rotating `SESSION_SECRET` invalidates credentials

Treat this value as a permanent encryption key, not as a password you rotate on a
schedule. Changing it invalidates in-progress login-stage tokens and makes stored
Gmail App Passwords plus the Second Brain embedding API key unreadable. Existing
passwords, step codes, TOTP enrolments, and database-backed sessions remain valid.
After an emergency rotation, rebuild with `aether deploy` and re-enter the email
and embedding credentials in the admin UI.

### Backups

Automatic, on every `aether update`: `.env` and the generated Nginx config, under
`.deploy/backups/`. On demand: `aether backup`.

Worth doing yourself:

- keep an offline copy of `.env` — it holds every secret, and nothing else does;
- use your PostgreSQL provider's built-in backups for the database;
- R2 objects are already durable on Cloudflare's side.

### Why schema updates need no manual step

- PostgreSQL is external; Redis runs in Docker on the VPS and stores queues/cache.
- Production should use its own PostgreSQL database, not the development database.
- During every install and update, the setup container runs **`npm run db:push`**
  against the `DATABASE_URL` configured on that VPS. It compares
  `src/shared/infrastructure/db/schema.ts` with that database and applies the
  difference; when they already match it is a no-op.

> **Back up production before a destructive schema change.** Adds and compatible
> indexes are routine, but a rename, type change, or removal can cause data loss or
> require an explicit SQL migration. Do not rely on an unattended `db:push` for
> those changes: prepare and test the migration first, then deploy compatible app
> code.

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

- Re-copy `DATABASE_URL` from your PostgreSQL provider dashboard — it must be **one unbroken line**.
- Check your provider's IP allowlist settings → add the VPS IP (printed by the installer
  when the connection is refused), or disable the restriction temporarily.
- Verify with `aether doctor`.

### `.env` is malformed (stray quote or newline inside a value)

A value pasted across two lines produces:

```env
R2_SECRET_ACCESS_KEY="
acf230cb..."
```

Repair it in place, or edit it yourself:

```bash
./install.sh --fix-env    # normalise to KEY=value, fill defaults, re-validate
nano .env                 # or just fix the line, then ./install.sh
```

### Uploads fail with a CORS error

- The R2 bucket CORS policy must list your HTTPS origin (see
  [Configure R2 CORS](#1-configure-r2-cors)).
- `NEXT_PUBLIC_APP_URL` must match the URL in the browser's address bar.

### R2 verification fails during install

Run the verifier directly to see Cloudflare's real error without printing any
secret value:

```bash
docker compose -f docker/docker-compose.yml --profile setup run --rm setup npm run r2:verify
```

Use the **S3 API credentials** created under Cloudflare R2 → Manage R2 API Tokens,
not a normal Cloudflare API token. The token needs Object Read & Write access to
the exact bucket in `R2_BUCKET_NAME`. Copy the Access Key ID and Secret Access Key
into their matching `.env` fields; they are different values.

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

Set the new value as `MASTER_PASSWORD` in `.env`, then run:

```bash
aether reset-password
```

The equivalent low-level command is:

```bash
docker compose -f docker/docker-compose.yml --profile setup run --rm setup npm run reset-master-password
```

> Changing `SESSION_SECRET` is not a password reset. It makes stored Gmail App
> Passwords and the embedding API key unreadable; re-enter both from the admin
> panel afterwards.

---

## Deployment architecture

```
Internet → Nginx (:443, TLS) → Next.js app (:3000)
                             ↘ Redis → Worker (thumbnails, cleanup, webhooks)

External: PostgreSQL · Cloudflare R2 · Gmail SMTP (senders you add)
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
