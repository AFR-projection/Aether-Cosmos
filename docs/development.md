# 🛠️ Development Workflow

Developer guide for contributing to Storage ByAFR.

---

## Development Setup

See [Getting Started](getting-started.md) for initial setup.

---

## Testing

```bash
npm test                      # Run all tests
npm run test:watch            # Watch mode
```

**Test Coverage:** 313 tests passing (35 files)

---

## Code Style

- **TypeScript** strict mode
- **ESLint** — Run `npm run lint`
- **Prettier** — Auto-format on save

---

## Project Conventions

- Use App Router (not Pages Router)
- Server Components by default
- Client Components only when needed (`'use client'`)
- Colocate tests with source files

---

**See Also:**
- [Architecture](architecture.md) — Project structure
- [API Reference](api-reference.md) — API design
