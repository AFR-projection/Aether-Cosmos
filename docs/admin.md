# Admin Panel

What a master account can do at `/admin`, and where each control actually lives.

Only accounts with the `master` role reach these pages; the role is re-checked
server-side on every request, not just hidden in the UI.

---

## Pages

| Page | Path | Contents |
|------|------|----------|
| Overview | `/admin` | Users (total / active / suspended), files, notes, folders, storage used against total quota, share links, active sessions, 7-day logins / uploads / downloads, a 30-day storage-growth series, and file-type distribution by MIME type |
| Users | `/admin/users` | The user list with create, edit, suspend, delete, and impersonate |
| User detail | `/admin/users/[id]` | One account: storage breakdown by type, files and folders, recent activity, active sessions, quota, and forced password reset |
| Logs | `/admin/logs` | Activity log with filtering by action type |
| Shares | `/admin/shares` | Every share link on the platform |
| Email | `/admin/email` | Gmail senders, verification, per-sender state, delivery logs |
| Settings | `/admin/settings` | Platform configuration (below) |

## User management

- Create accounts, edit them, suspend, and delete.
- **Impersonate** — sign in as a user for support. Every impersonation is written
  to the activity log as its own action type; it is not a silent switch.
- **Quota** — set per user, in GB.
- **Force password reset** — `mustChangePassword`; the user must set a new password
  at next sign-in.
- **Sessions** — see each active session for that user and revoke one, or all of
  them at once.

## Settings

Six groups, all persisted in `system_settings` and cached for 30 s:

| Group | Settings |
|-------|----------|
| General | Allow registration, maintenance mode, maintenance message |
| Storage | Default quota (GB), max upload size (MB), storage warning threshold (%) |
| Security | Session duration (hours), max concurrent sessions per user, API rate limit (req/min per user), require 2-Step Code |
| Files | Max file lifetime (days, `0` = unlimited), auto-delete trash after N days, blocked extensions, allowed MIME types |
| Retention | Activity-log retention (days) |
| Email delivery | Default daily limit per sender, failure threshold, cooldown duration |

Defaults worth knowing: quota 10 GB, max upload 500 MB, session 168 h, max
sessions 10, rate limit 60 req/min, trash auto-delete 30 days, log retention 90
days, registration **off**. Upload endpoints receive a multiple of the rate-limit
value rather than a fixed floor, so lowering it lowers batch throughput
proportionally.

Blocked extensions ship as `.exe .bat .cmd .com .msi .scr .vbs .ps1 .sh`, and
uploads are validated by magic bytes as well as by the declared MIME type.

Turning on **Require 2-Step Code** forces enrolment at next sign-in for every user
and prevents them from removing it afterwards.

## Email senders

Delivery is SMTP through Gmail accounts you add. Each sender needs a Gmail **App
Password**, stored as AES-256-GCM ciphertext with a key derived from
`SESSION_SECRET` — so rotating that secret makes every stored password unreadable
and they must be re-entered here.

The router picks a sender per send: it skips any sender over its rolling 24-hour
cap or on cooldown, and among the rest prefers the lowest `priority` number, then
the one used longest ago. Counters live in the database, so they survive restarts
and are shared across app instances.

## Admin API

The admin pages are backed by `/api/admin/*`. Most of those routes accept a
**master API key** (`skm_…`) carrying the matching `admin:<area>` scope —
`admin:users`, `admin:settings`, `admin:stats`, `admin:monitoring`,
`admin:shares`, `admin:email`. Two are session-only by design:
`/api/admin/api-keys` and `/api/admin/events`.

A master key sees admin paths in `GET /api/v1/openapi`; a user key does not. See
[API Reference](api-reference.md).

---

**See also:** [Features](features.md) · [API Reference](api-reference.md) ·
[Deployment](deployment.md)
