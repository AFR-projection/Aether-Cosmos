# Architecture

How Aether Cosmos ByAFR is put together: the stack, the layout on disk, how a request
flows, and where the security boundaries are.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.2 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5, strict mode |
| Database | PostgreSQL (Neon) + Drizzle ORM 0.45 over postgres.js |
| Object storage | Cloudflare R2 (S3-compatible) |
| Cache, queue, rate limits | Redis + BullMQ 5 |
| Authentication | Session cookies over Argon2id (`@node-rs/argon2`) |
| UI | Tailwind CSS v4, Radix UI, Framer Motion |
| Tests | Vitest 3 (Node environment) |
| Deployment | Docker Compose + Nginx + Certbot |

Each store has exactly one job, and the boundaries do not move:

| Store | Role |
|-------|------|
| PostgreSQL | Canonical source of truth for all metadata and Second Brain content |
| Cloudflare R2 | File bodies only — never metadata, never memory |
| Redis | Cache, job queue, rate-limit counters — never a source of truth |

Redis or R2 being down degrades the product; it does not lose data.

---

## Project layout

```
storage-by-afr/
├── app/                    # App Router: pages + REST API routes
│   ├── api/                #   every endpoint (app/api/**/route.ts)
│   ├── files/              #   file browser
│   ├── brain/              #   Second Brain workspace
│   ├── graph-workspace/    #   popped-out graph window
│   ├── admin/              #   admin panel
│   ├── settings/           #   account settings
│   └── shared/             #   public share-link pages
├── components/             # React components (brain/, files/, layout/, ui/, …)
├── hooks/                  # Client hooks (realtime events, graph settings, …)
├── lib/                    # Server and shared logic
│   ├── db/                 #   Drizzle schema + client
│   ├── auth/               #   sessions, API keys, 2FA
│   ├── storage/            #   R2 client, upload service
│   ├── brain/              #   Second Brain (see second-brain-architecture.md)
│   ├── queue/              #   BullMQ producers
│   ├── search/             #   PostgreSQL full-text search
│   ├── security/           #   CSRF, rate limits, file validation
│   └── …                   #   email, oauth, webhooks, realtime, preview, …
├── workers/                # Background worker entry point
├── drizzle/                # SQL migrations
├── scripts/                # Operational scripts (bootstrap, deploy, migrations)
├── docker/                 # Compose files, Nginx template, R2 CORS
├── tests/                  # Cross-module tests
└── docs/                   # This documentation
```

Tests are colocated with the code they cover (`lib/**/*.test.ts`), which is where
Vitest looks — alongside `tests/**/*.test.ts`. Files under `app/**` are not part of
the test run.

---

## Request flows

**Upload.** File bytes never pass through the application server:

```
Browser ──presign──► Next.js API ──► R2 (presigned PUT)
   │                                    │
   └──────────── complete ──────────────┘──► PostgreSQL (metadata)
                        │
                        └──► BullMQ ──► Worker ──► thumbnail / compression
```

Large files are split into parts (`/api/uploads/[id]/parts/sign` → `commit`), so an
interrupted upload resumes instead of restarting.

**Download.** The API issues a short-lived presigned GET (60 s by default);
encrypted files are decrypted in the browser afterwards.

**Authentication.**

```
Login → Argon2id verify → (optional step code, TOTP) → session row
      → httpOnly, secure cookie → proxy.ts validates on every request
```

**Realtime.** Mutations publish to Redis; `/api/events` streams server-sent events
to open tabs, which update their React Query caches.

**Second Brain cross-window sync.**

```
Main window ──mutation──► React Query ──► BroadcastChannel ──► popped-out graph
```

---

## Security layers

1. **`proxy.ts`** — Next.js proxy (the file formerly called `middleware.ts`):
   public-path allowlist, session validation, bot filtering, HSTS and security
   headers.
2. **CSRF** — Token required on every mutating request.
3. **Rate limiting** — Login throttling and per-endpoint limits; Redis fixed-window
   counters, with an in-process fallback when Redis is disabled.
4. **File validation** — Magic-byte inspection on upload completion, not just the
   declared MIME type.
5. **Presigned URLs** — Time-limited R2 access, so object URLs cannot be shared
   indefinitely.
6. **Scope separation** — Storage API scopes and `brain.*` scopes are distinct
   namespaces; the storage `full` scope grants no Brain access, and OAuth tokens
   cannot hold `brain.*` at all.
7. **Brain isolation** — Every Second Brain query is filtered by `brain_id` at a
   single choke point. See
   [Second Brain Architecture § Isolation](second-brain-architecture.md#isolation).
8. **End-to-end encryption (optional)** — AES-GCM in the browser; the server holds
   ciphertext and no key material.

Secrets derived from `SESSION_SECRET`: TOTP secrets, step codes, and stored email
credentials are encrypted with a key derived from it. Rotating it invalidates all
three — plan for re-entering them rather than treating it as a free rotation.

---

## Processes

| Process | Responsibility |
|---------|----------------|
| `next start` (app) | HTTP, pages, REST API, MCP endpoint, SSE |
| `npm run worker` | BullMQ consumers: thumbnails, compression, media, retention cleanup, webhook delivery, Brain enrichment sweeps |
| Redis | Queue transport, pub/sub, rate-limit counters, cache |
| Nginx | TLS termination and reverse proxy |

The default deployment runs one app container. Nothing in the app requires it:
sessions live in PostgreSQL, realtime fan-out goes through Redis pub/sub, email
sender accounting is stored in `mail_senders` rather than in memory, and the MCP
transport issues no session id. Scaling out is a compose change, not a rewrite.

---

**See also:** [Getting Started](getting-started.md) ·
[Development](development.md) · [API Reference](api-reference.md) ·
[Second Brain Architecture](second-brain-architecture.md)



