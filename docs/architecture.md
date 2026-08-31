# Architecture

How Aether Cosmos ByAFR is put together: the stack, the layout on disk, how a request
flows, and where the security boundaries are.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.3 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5, strict mode |
| Database | PostgreSQL + Drizzle ORM 0.45 over postgres.js |
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

`app/` is routing only — a page or route handler wires a request to code under
`src/`, and holds no logic of its own. Everything else lives in one of four places,
ordered here from most generic to most specific:

```
aether-cosmos/
├── app/                    # App Router: pages + REST API routes (routing only)
│   ├── api/                #   every endpoint (app/api/**/route.ts)
│   ├── files/              #   file browser
│   ├── brain/              #   Second Brain workspace
│   ├── graph-workspace/    #   popped-out graph window
│   ├── admin/              #   admin panel
│   ├── settings/           #   account settings
│   └── shared/             #   public share-link pages
├── src/
│   ├── shared/             # The platform. Knows no feature.
│   │   ├── api/            #   response envelope, body parsing, OpenAPI docs
│   │   ├── infrastructure/ #   db, cache, queue, email, realtime, webhooks
│   │   └── lib/            #   auth kernel, security, i18n, search, monitoring, …
│   ├── ui/                 # Design system. Renders; composes nothing.
│   │   ├── primitives/     #   buttons, inputs, dialogs (Radix + Tailwind)
│   │   ├── feedback/       #   spinner, toast, offline overlay, page progress
│   │   ├── hooks/          #   generic hooks (media query, debounce, SSE)
│   │   ├── i18n/           #   locale provider + switcher
│   │   └── providers/      #   theme provider
│   ├── shell/              # Application shell. The one place outside app/ that
│   │   ├── layouts/        #   may import features: sidebar, header, command
│   │   ├── compositions/   #   palette, quick actions, onboarding, feedback
│   │   └── providers.tsx   #   the provider stack every page is wrapped in
│   └── features/           # One folder per bounded context, layered inside
│       ├── brain/          #   Second Brain (see second-brain-architecture.md)
│       ├── files/          #   files, folders, notes, previews, uploads
│       ├── auth/           #   login, account and session UI
│       ├── admin/          #   admin console
│       └── shares/         #   public share links
├── workers/                # Background worker entry point
├── drizzle/                # SQL migrations
├── scripts/                # Operational scripts (bootstrap, deploy, migrations)
├── docker/                 # Compose files, Nginx template, R2 CORS
├── tests/                  # Cross-module tests
└── docs/                   # This documentation
```

### Layers inside a feature

```
src/features/<feature>/
├── domain/          # Rules, algorithms and types. No database, no browser.
├── application/     # Use cases over domain + infrastructure.
│   ├── commands/    #   they mutate
│   ├── queries/     #   they only read
│   └── jobs/        #   they run in the worker
├── infrastructure/  # Adapters: authorization lookups, MCP transport, R2, …
└── presentation/    # Components, hooks, and the graph canvas engine.
```

The test of `domain/` is whether the module still makes sense with no database and
no DOM: `graph/algorithms.ts` (PageRank over memory links) and `retrieval/score.ts`
belong there; `path-service.ts`, which reaches for Postgres to answer the same
question, is a query and lives in `application/queries/`. A module that takes a `db`
handle as a parameter is still a query — the injection makes it testable, not pure.

### Dependency rules

| From | May import |
|------|-----------|
| `app/**`, `src/shell/**` | anything |
| `src/features/<f>/presentation` | its own feature, `src/shared`, `src/ui` |
| `src/features/<f>/application`, `infrastructure` | its own domain, `src/shared` |
| `src/features/<f>/domain` | its own domain, `src/shared` (except infrastructure) |
| `src/ui/**` | `src/ui`, `src/shared` |
| `src/shared/**` | `src/shared` |

Two directions hold: nothing generic depends on something specific, and nothing
inner depends on something outer. Two features never import each other — whatever
they share moves down into `src/shared`, and whatever composes them moves up into
`app/` or `src/shell`.

These are not honour-system rules. `eslint.config.mjs` encodes each row as a
`no-restricted-imports` block, with every exception listed there by filename and
justified in a comment. `npm run lint` fails on a new violation.

### Import aliases

| Alias | Resolves to |
|-------|-------------|
| `@/shared/*` | `src/shared/*` |
| `@/ui/*` | `src/ui/*` |
| `@shell/*` | `src/shell/*` |
| `@brain/*` | `src/features/brain/*` |
| `@files/*` | `src/features/files/*` |
| `@auth/*` | `src/features/auth/*` |
| `@admin/*` | `src/features/admin/*` |
| `@shares/*` | `src/features/shares/*` |
| `@/*` | repository root (`app/`, `workers/`, …) |

The alias, not the relative path, is what makes a boundary violation visible in a
diff: `../../../shared/lib/auth/session` reads like a local detail, while
`@/shared/lib/auth/session` names the layer it crosses. Relative imports are for
siblings inside one folder.

Tests are colocated with the code they cover (`src/**/*.test.ts`), which is where
Vitest looks — alongside `tests/**/*.test.ts` for anything that spans modules.
Files under `app/**` are not part of the test run.

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



