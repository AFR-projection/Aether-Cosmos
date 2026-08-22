# Features

What Storage ByAFR does, grouped by area. Setup instructions live in
[Getting Started](getting-started.md); the Second Brain has its
[own documentation set](second-brain.md).

---

## Files

- **Upload** — Drag-and-drop, multi-file, and whole-folder upload with the
  directory structure preserved (File System Access API, with a `webkitdirectory`
  fallback for browsers that lack it).
- **Multipart uploads** — Large files are uploaded in parts, straight to R2 via
  presigned URLs, with resume, retry, and cancel.
- **Preview** — Images, video, audio, PDF, Office documents, SVG, and text with
  syntax highlighting; archives can be listed and extracted.
- **Organization** — Folders, favorites, type filters (images / video / audio /
  documents / archives), sortable columns, and multi-select batch actions
  (download, favorite, delete).
- **Virtual scrolling** — Thousands of rows render without degrading, via
  `@tanstack/react-virtual`.
- **Search** — PostgreSQL full-text search with ranked results and `websearch`
  query syntax.
- **Versions** — Files keep prior versions and can be restored.
- **Recycle bin** — Soft delete grouped by age (Today / Yesterday / This Week /
  This Month / Older), with batch restore and permanent delete.
- **Editing in place** — Rich-text notes (Tiptap, auto-saving) and a built-in
  image editor with crop, rotate, and flip.

## Sharing

- **Share links** — Expiry, access limits, and view or edit permission.
- **Access logs** — Every visit records IP, device, browser, OS, and location.
- **Folder collaboration** — Invite other accounts into a folder with a role.
- **Shared with me** — A dedicated view of what others shared with you.

## Security

- **End-to-end encryption (optional)** — AES-GCM in the browser before upload. The
  server stores ciphertext and never sees the passphrase; downloads decrypt
  in-browser. ZIP and batch downloads exclude encrypted files by design, because
  the server cannot decrypt them. A lost passphrase means an unrecoverable file.
- **Authentication** — Session cookies (httpOnly, secure) over Argon2id password
  hashing, an optional numeric second step, and TOTP 2FA with recovery codes.
- **Password policy** — Minimum 10 characters across at least 3 character classes,
  with forced reset (`mustChangePassword`) available to admins.
- **Session management** — See every signed-in device and revoke individually.
- **OTP delivery** — Email over SMTP, using Gmail senders added in Admin → Email.
  A router spreads volume across the pool with a rolling daily cap per sender, a
  cooldown after repeated failures, and least-recently-used rotation.
- **Rate limiting** — Login throttling and per-endpoint limits, Redis-backed with
  an in-process fallback when Redis is absent.
- **Hardening** — CSRF tokens on mutations, security headers, bot filtering,
  magic-byte file validation, and time-limited presigned URLs.

## Administration

Covered in detail in [Admin Panel](admin.md): user management, impersonation, a
shares center, storage analytics, platform settings, and activity logs.

## Platform APIs

- **REST API** — Scoped API keys, an OpenAPI 3.0 spec served by the app itself.
  See [API Reference](api-reference.md).
- **Webhooks** — Registered endpoints with test delivery, dispatched by the worker.
- **OAuth** — Register clients, authorize, and issue access tokens for third-party
  apps. OAuth tokens can never carry `brain.*` scopes.
- **Quotas** — Per-user storage limits, enforced on upload.

## Realtime and background work

- **Live events** — Server-sent events drive a connection-status pill
  (Connecting / Live / Reconnecting / Offline), toasts, and progress indicators.
- **Background jobs** — Thumbnails, image compression, media processing, retention
  cleanup, and webhook delivery run on BullMQ in a separate worker process.

## Interface

- Desktop-first responsive layout with dark and light themes (persisted locally).
- **Lite mode** — Drops heavy visual effects and loads smaller thumbnails; follows
  the device and network by default, with a manual override in Settings.
- Command palette (`⌘K` / `Ctrl+K`) for navigation.

## Second Brain

Persistent, user-owned memory for AI agents: versioned memories, projects, an
interactive knowledge graph, hybrid retrieval, and an MCP server. Start at
[Second Brain](second-brain.md).

---

**See also:** [Getting Started](getting-started.md) · [Admin Panel](admin.md) ·
[API Reference](api-reference.md)

