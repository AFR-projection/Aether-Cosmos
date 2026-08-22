# Development

Working on Storage ByAFR: commands, verification gates, and the conventions the
codebase already follows.

Initial setup is in [Getting Started](getting-started.md).

---

## Commands

```bash
npm run dev                   # dev server (Turbopack)
npm run build                 # production build
npm run lint                  # eslint
npx tsc --noEmit              # typecheck
npm test                      # full test suite (vitest run)
npm run test:watch            # vitest in watch mode
npm run worker                # background worker (needs Redis)

npm run db:push               # sync schema to the database
npm run db:generate           # generate a migration from schema changes
npm run db:studio             # Drizzle Studio
npm run bootstrap             # create the master admin
npm run reset-master-password # reset it
```

Two scripts drive a live server instead of the test runner, and write to whatever
`DATABASE_URL` points at:

```bash
npm run test:brain            # end-to-end MCP flow against a running app
npm run test:api-keys         # API key flow
```

---

## Verification gates

Before considering a change done, all three must pass:

```bash
npx tsc --noEmit
npx eslint <changed files>
npm test
```

`tsc` does not see files inside dot-directories (for example
`app/.well-known/**`) — only `next build` catches type errors there.

---

## Tests

Vitest runs in the Node environment and collects `lib/**/*.test.ts` and
`tests/**/*.test.ts`. Tests are colocated with the code they cover.

Consequences worth knowing:

- A test placed under `app/**` will never run. Route logic is tested by extracting
  it into `lib/` and testing that.
- Database access is faked, not mocked away: the suite uses recording fakes that
  stage writes inside a transaction and only "commit" them on resolve, so
  atomicity and rollback are asserted directly rather than assumed.
- Nothing in the suite needs `DATABASE_URL`, Redis, or R2. If a test does, it is
  in the wrong place.

Current state is reported in the [documentation index](README.md#project-status).

Two rules the suite depends on:

1. Never weaken a test to make it pass — fix the code or the expectation, and say
   which.
2. Never change production behaviour just so a test goes green.

---

## Conventions

- **App Router only.** No Pages Router. Server Components by default; add
  `"use client"` only where interactivity requires it.
- **This is Next.js 16.** APIs and file conventions differ from earlier versions —
  the bundled docs in `node_modules/next/dist/docs/` are the authority, not memory
  of older releases. Heed deprecation notices there.
- **The proxy file is `proxy.ts`**, not `middleware.ts`.
- **Schema first.** `lib/db/schema.ts` is the source of truth; enum lists used by
  validation are derived from it (`lib/brain/constants.ts`) so zod and Postgres
  cannot drift.
- **Migrations are additive.** The database was bootstrapped with `db:push`, so
  `__drizzle_migrations` is empty and `drizzle-kit migrate` would replay from zero.
  Apply a single file with `npx tsx scripts/apply-migration.ts <file.sql>` instead.
  Do not write destructive migrations; do not rename or drop existing tables.
- **Errors.** Return typed messages through `lib/api/response.ts`; SQL text and
  stack traces stay in the server log.
- **Comments** explain why, not what, and match the density of the file they are in.

## Version stamping

`package.json` declares the version; `lib/app-version.ts` mirrors it as a literal
for the client bundle, and `lib/app-version.test.ts` fails if the two drift. When
releasing, bump both — the test tells you if you forgot. The version is shown in
Settings → About.

---

**See also:** [Architecture](architecture.md) · [API Reference](api-reference.md) ·
[Troubleshooting](troubleshooting.md)

