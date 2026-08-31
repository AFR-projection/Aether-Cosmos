# 🚀 Getting Started

Complete guide for installing and configuring Aether Cosmos ByAFR for local development.

---

## Prerequisites

### Local Development
- **Node.js** ≥ 20
- **npm** ≥ 10
- **PostgreSQL** (managed provider or local)
- **Cloudflare R2** account
- **Redis** (optional, can disable with `REDIS_DISABLED=true`)

### Production VPS
- **Ubuntu** 22.04+
- **Docker** & Docker Compose
- See [Deployment Guide](deployment.md) for complete details

---

## Installation

### 1. Clone Repository

```bash
git clone <repo-url>
cd Aether-Cosmos
npm install
```

### 2. Environment Configuration

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Database
DATABASE_URL="postgresql://user:pass@host/dbname"

# Cloudflare R2
R2_ACCOUNT_ID="your-account-id"
R2_ACCESS_KEY_ID="your-access-key"
R2_SECRET_ACCESS_KEY="your-secret-key"
R2_BUCKET_NAME="your-bucket-name"
R2_PUBLIC_URL="https://pub-xxxxx.r2.dev"

# Session & Authentication
SESSION_SECRET="minimum-64-random-characters-here"
MASTER_USERNAME="admin"
MASTER_PASSWORD="ReplaceMe-Strong-2026!"

# Application
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NODE_ENV="development"

# Redis (optional)
REDIS_URL="redis://localhost:6379"
REDIS_DISABLED="true"  # Set true if not using Redis
```

Upload ceilings, presigned-URL lifetimes, login lockout thresholds, session
timeouts and sharing policy are **not** environment variables — they live in
**Admin → Settings**, are stored in the database and take effect within about 30
seconds without a redeploy.

### 3. Database Setup

```bash
# Push schema to database
npm run db:push

# Create master admin (first time only)
npm run bootstrap

# (Optional) Reset master password if forgotten
npm run reset-master-password
```

### 4. R2 CORS Configuration

Access **Cloudflare Dashboard** → **R2** → **Bucket** → **Settings** → **CORS**.

Use configuration from `docker/r2-cors.json`:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://your-domain.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Or via Wrangler CLI:

```bash
npx wrangler r2 bucket cors set YOUR-BUCKET-NAME --file docker/r2-cors.json
```

### 5. Start Development

```bash
# Terminal 1: Next.js dev server
npm run dev

# Terminal 2: Background worker (if using Redis)
npm run worker
```

Access the application at **http://localhost:3000**.

> **💡 Note:** Without Redis, set `REDIS_DISABLED=true` and skip the worker. Auto-cleanup features (trash, file lifetime, activity logs) require Redis + worker.

---

## Optional: Redis via Docker

To use Redis for development:

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

Then set `REDIS_DISABLED=false` in `.env`.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | - | PostgreSQL connection string |
| `R2_ACCOUNT_ID` | ✅ | - | Cloudflare R2 Account ID |
| `R2_ACCESS_KEY_ID` | ✅ | - | R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | ✅ | - | R2 Secret Key |
| `R2_BUCKET_NAME` | ✅ | - | R2 bucket name |
| `R2_PUBLIC_URL` | ✅ | - | Bucket public URL (dev: `https://pub-<hash>.r2.dev`) |
| `SESSION_SECRET` | ✅ | - | Minimum 32 characters; the installer generates 64 hexadecimal characters. Rotating it invalidates in-progress login tokens plus stored email and embedding credentials — see [Deployment § SESSION_SECRET](deployment.md#rotating-session_secret-invalidates-credentials). |
| `MASTER_USERNAME` | ✅ | - | Master admin username: 3–50 letters, numbers, dots, underscores, or hyphens |
| `MASTER_PASSWORD` | ✅ | - | 10–128 characters using at least 3 of lowercase, uppercase, number, and special character |
| `NEXT_PUBLIC_APP_URL` | ✅ | `http://localhost:3000` | Application base URL |
| `BRAIN_EMBEDDING_PROVIDER` | ❌ | `none` | Embedding provider: `none` (default, semantic search abstains) or `openai` / `voyageai` (requires API key). See [Second Brain 2.0 § Embeddings](second-brain-2.0.md#embeddings). |
| `REDIS_URL` | ❌ | `redis://localhost:6379` | Redis connection string |
| `REDIS_DISABLED` | ❌ | `false` | Set `true` to disable Redis |
| `NODE_ENV` | ❌ | `development` | Environment mode |
| `COOKIE_SECURE` | ❌ | `false` | Set `true` for production (HTTPS) |

### Configured in the UI, not the environment

These used to be environment variables and are now fields in **Admin → Settings**,
persisted in the database and applied within ~30 seconds:

| Setting | Section | Default | Replaces |
|---------|---------|---------|----------|
| Max Upload Size | Storage | `500 MB` | `MAX_FILE_SIZE_BYTES` |
| Upload URL Lifetime | Storage | `15 min` | `UPLOAD_URL_EXPIRY_SECONDS` |
| Download URL Lifetime | Storage | `60 s` | `DOWNLOAD_URL_EXPIRY_SECONDS` |
| Idle Timeout | Security | `0` (off) | `SESSION_INACTIVITY_MS` |
| IP Binding | Security | `auto` (production only) | `SESSION_IP_BIND` |
| Failed Logins per Account | Limits | `5` | `RATE_LIMIT_LOGIN_MAX` |
| Failed Logins per IP | Limits | `30` | `RATE_LIMIT_LOGIN_IP_MAX` |
| Lockout Window | Limits | `15 min` | `RATE_LIMIT_LOGIN_WINDOW_MS` |

`COOKIE_SECURE` and `HSTS_ENABLED` stay environment-only on purpose: a
database-backed toggle would let a compromised admin account downgrade transport
security.

---

## Development Commands

```bash
# Development
npm run dev                   # Start dev server
npm run build                 # Build for production
npm run start                 # Start production server
npm run lint                  # Run ESLint
npm test                      # Run test suite

# Database
npm run db:push               # Push schema to database
npm run db:studio             # Open Drizzle Studio
npm run bootstrap             # Create master admin
npm run reset-master-password # Reset master password

# Worker (requires Redis)
npm run worker                # Start background worker
```

---

## Verify Installation

After running `npm run dev`, open your browser to `http://localhost:3000`:

1. **Login** with your `MASTER_USERNAME` and `MASTER_PASSWORD`
2. **Upload a file** to test R2 integration
3. **Open Second Brain** in the sidebar (or press `⌘K` → type "brain")
4. **Check browser console** — there should be no red errors

---

## Next Steps

- 📖 [Architecture](architecture.md) — Understand the project structure
- 🚀 [Deployment](deployment.md) — Deploy to production VPS
- 🧠 [Second Brain Setup](second-brain.md) — Configure knowledge graph for AI agents
- 🔧 [Troubleshooting](troubleshooting.md) — Resolve common issues

---

## Quick Troubleshooting

| Error | Solution |
|-------|----------|
| `[ioredis] Unhandled error` | Set `REDIS_DISABLED=true` or start Redis |
| Upload fails / CORS error | Configure R2 CORS using `docker/r2-cors.json` |
| Worker `ENOTFOUND redis` | Hostname `redis` is Docker-only; locally set `REDIS_DISABLED=true` |
| Folder upload structure | Chrome/Edge use `showDirectoryPicker()`, fallback is `webkitdirectory` |

For complete troubleshooting, see [Troubleshooting Guide](troubleshooting.md).
