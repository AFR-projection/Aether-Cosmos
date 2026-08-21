# 🏗️ Architecture Overview

Technical architecture and project structure of Storage ByAFR.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 16.2.10 (App Router) |
| **Language** | TypeScript 5 (strict mode) |
| **Database** | Neon PostgreSQL + Drizzle ORM 0.45 |
| **Storage** | Cloudflare R2 (S3-compatible) |
| **Cache & Queue** | Redis + BullMQ 5 |
| **Authentication** | Session-based (Argon2id) |
| **UI** | Tailwind CSS v4 + Framer Motion + Radix UI |
| **Deployment** | Docker Compose + Nginx |

---

## Project Structure

```
storage-by-afr/
├── app/                    # Next.js App Router
│   ├── api/               # REST API routes
│   ├── brain/             # Second Brain UI
│   ├── files/             # File browser
│   ├── admin/             # Admin panel
│   └── graph-workspace/   # Popup graph window
├── components/            # React components
│   ├── brain/            # Second Brain components
│   ├── files/            # File management UI
│   ├── layout/           # AppShell, Sidebar
│   └── ui/               # Shared UI components
├── lib/                   # Core libraries
│   ├── brain/            # Second Brain logic
│   ├── auth/             # Authentication
│   ├── storage/          # R2 client
│   ├── db/               # Database & schema
│   └── queue/            # Background jobs
├── hooks/                 # React hooks
├── workers/               # Background worker
├── docs/                  # Documentation
└── docker/                # Docker configs
```

---

## Data Flow

### Upload Flow
```
Browser ──presigned URL──► Cloudflare R2 ──complete──► Next.js API ──► PostgreSQL
    │                                                            │
    └──(optional)─────────► BullMQ ──► Worker ──► Thumbnail
```

### Authentication Flow
```
Login ──► Argon2id hash ──► Session created ──► Cookie (httpOnly, secure)
```

### Second Brain Sync
```
Main Window ──mutation──► React Query ──► BroadcastChannel ──► Popup Window
```

---

## Security Layers

1. **Middleware** — Bot detection, session validation, security headers
2. **CSRF Protection** — Token validation on mutations
3. **Rate Limiting** — Login throttling, API abuse prevention
4. **File Validation** — Magic byte verification
5. **Presigned URLs** — Time-limited R2 access
6. **E2E Encryption** — Client-side AES-GCM (optional)
7. **Brain Isolation** — Row-level `brain_id` authorization

---

**See Also:**
- [Getting Started](getting-started.md) — Installation guide
- [Development](development.md) — Development workflow
- [API Reference](api-reference.md) — API documentation
