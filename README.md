# Aether Cosmos ByAFR

**v0.4.0** · Self-hosted cloud storage with a Second Brain knowledge layer for AI agents.

Files live in Cloudflare R2, metadata and memory live in PostgreSQL, and the whole
thing runs on a single Ubuntu VPS behind Nginx. Built with Next.js 16, Drizzle ORM,
and Redis + BullMQ.

**[Documentation](docs/README.md)** · [Getting Started](docs/getting-started.md) · [Deployment](docs/deployment.md) · [Second Brain](docs/second-brain.md) · [API](docs/api-reference.md)

---

## What it does

- **Storage** — Upload (including whole folders), preview, share, version, and
  recycle-bin files; full-text search; optional end-to-end encryption where the
  server never sees the passphrase.
- **Accounts** — Session auth with Argon2id, TOTP 2FA, a numeric second step,
  email OTP delivery, and per-user quotas.
- **Admin** — User management, impersonation, share auditing, storage analytics,
  platform settings, activity logs.
- **Second Brain** — Persistent, user-owned memory for AI agents: versioned
  memories, an interactive knowledge graph, hybrid retrieval, and an MCP server
  agents connect to over HTTP.
- **Platform APIs** — API keys with scopes, webhooks, OAuth clients, an OpenAPI
  spec served from the app itself.

Full list: [docs/features.md](docs/features.md).

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.2 (App Router) + React 19 |
| Language | TypeScript 5, strict |
| Database | PostgreSQL (Neon) + Drizzle ORM 0.45 |
| Object storage | Cloudflare R2 (S3-compatible) |
| Cache & queue | Redis + BullMQ 5 |
| UI | Tailwind CSS v4, Radix UI, Framer Motion |
| Deployment | Docker Compose + Nginx + Certbot |

---

## Quick start

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, R2 keys, SESSION_SECRET
npm run db:push             # sync schema
npm run bootstrap           # create the master admin
npm run dev                 # http://localhost:3000
```

Redis is optional locally — set `REDIS_DISABLED=true` and skip the worker. Full
walkthrough, including every environment variable: [Getting
Started](docs/getting-started.md).

## Common commands

```bash
npm run dev        # dev server
npm run build      # production build
npm run lint       # eslint
npm test           # vitest (2382 tests)
npm run worker     # background worker (requires Redis)
npm run db:studio  # Drizzle Studio
```

## Production

One command on a fresh Ubuntu VPS — installs Docker, clones, opens `.env` in an
editor for you to fill in, issues the certificate, builds, and health-checks:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-Cosmos/main/scripts/deploy/setup.sh | bash
```

Afterwards, everything runs through one command:

```bash
aether update      # pull, rebuild, sync schema, renew certificates, verify
aether status      # health of every service
aether logs app    # follow logs
aether help        # the rest
```

See [Deployment](docs/deployment.md) for prerequisites, DNS, R2 CORS, the
inspect-before-running form of that one-liner, and recovery.

---

## Documentation

All documentation lives in [`docs/`](docs/README.md) — that directory's README is
the only index. `CLAUDE.md` and `AGENTS.md` in this directory are instructions for
AI coding assistants, not user documentation.

## License

Private — all rights reserved.

