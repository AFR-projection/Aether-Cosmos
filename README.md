# Storage ByAFR

Modern cloud storage web application — fast, secure, and scalable.  
Built with **Next.js 16**, **Drizzle ORM**, **Cloudflare R2**, and **Redis**.

**📚 [Complete Documentation](docs/README.md)** · **🚀 [Getting Started](docs/getting-started.md)** · **🧠 [Second Brain](docs/second-brain.md)** · **🏗️ [Deploy VPS](docs/deployment.md)**

---

## 📚 Documentation

**Complete documentation is available in the [`docs/`](docs/) directory:**

- **[Getting Started](docs/getting-started.md)** — Installation, configuration, quick start
- **[Deployment Guide](docs/deployment.md)** — Production VPS deployment with Docker
- **[Architecture](docs/architecture.md)** — Tech stack, project structure, data flow
- **[Features](docs/features.md)** — File management, security, sharing
- **[Second Brain](docs/second-brain.md)** — Knowledge graph for AI agents
- **[API Reference](docs/api-reference.md)** — REST endpoints documentation
- **[Troubleshooting](docs/troubleshooting.md)** — Common issues & solutions

**Quick Start:** See [Getting Started § Installation](docs/getting-started.md#installation).

---

## Features

- **File Management** — Upload, download, rename, duplicate, favorite, drag-and-drop folder organization
- **Folder Upload** — Preserve full directory structure via File System Access API with `webkitdirectory` fallback
- **Virtual Scrolling** — Render thousands of files without performance degradation (`@tanstack/react-virtual`)
- **Multi-Select & Batch Actions** — Bulk download, favorite, and delete with parallel `Promise.all`
- **Type Filtering** — Quick filters: All / Images / Videos / Audio / Documents / Archives
- **Sortable Columns** — Sort by Name, Size, Modified date, or Type
- **File Preview** — Inline preview for images, video, audio, PDF, Office documents, SVG, and syntax-highlighted text
- **Rich Text Notes** — Tiptap editor with auto-save
- **Image Editor** — Built-in crop, rotate, and flip tools
- **Share Links** — Create shareable links with expiration, access limits, permissions (view/edit), and full access logging (IP, device, browser, OS, location)
- **Recycle Bin** — Soft-delete with time grouping (Today / Yesterday / This Week / This Month / Older), batch restore and permanent delete
- **Favorites** — Bookmark files for quick access
- **Search** — Full-text search across all files (PostgreSQL FTS with ranked results + `websearch` query syntax)
- **End-to-end encryption** — Optional client-side AES-GCM encryption on upload; files are stored as ciphertext (server never sees the passphrase). Download prompts for the passphrase, decrypts in-browser, and saves the original file. ZIP/batch excludes encrypted files by design.
- **Admin Panel** — User management, impersonation, Shares Center, storage analytics (30d growth + MIME charts), real-time monitoring, activity logs
- **Enterprise security** — TOTP 2FA + recovery codes, forced password reset (`mustChangePassword`), stronger password policy (min 10, 3 character classes), account suspension with reason, session management
- **Second Brain** — Persistent, user-owned memory for AI agents: versioned memories, projects, interactive knowledge graph with local/global views, semantic + context relationships, group visualization, per-agent scoped access, an MCP server, and a `/brain` workspace UI with pop-out graph window. See [Second Brain](#second-brain)
- **Platform APIs** — API keys, webhooks, folder collaboration, file versions, bandwidth quotas, client-side encryption hooks
- **Realtime feedback** — SSE live events, animated connection-status pill (Connecting / Live / Reconnecting / Offline), system toasts, page progress with comet-head, lightweight CSS-only loaders
- **Background Jobs** — Thumbnail generation, image compression, media processing, webhook delivery via BullMQ
- **Dark / Light Mode** — Custom theming with localStorage persistence
- **Responsive Design** — Desktop-first with premium UI (Framer Motion, gradients, glow effects)

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

See [Architecture Documentation](docs/architecture.md) for complete technical details.

---

## Commands

### Development
```bash
npm run dev           # Development server
npm run build         # Production build
npm run lint          # Run ESLint
npm test              # Run tests (313 passing)
npm run db:push       # Push schema to database
npm run worker        # Background worker (requires Redis)
```

### Production
```bash
./install.sh          # First-time installation
./update.sh           # Update deployment
```

See [Deployment Guide](docs/deployment.md) for complete instructions.

---

## License

Private — All rights reserved.

