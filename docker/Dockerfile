FROM node:20-alpine AS base

# npm gives up after 2 retries and treats a stalled socket as fatal, which a VPS on
# a congested link hits routinely — a dropped connection halfway through the install
# then fails the whole build. Retry harder, wait longer, and skip the audit/funding
# round-trips that add nothing to a deploy.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=180000 \
    NPM_CONFIG_FETCH_TIMEOUT=600000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
# Cache mount, so a retry after a network drop resumes from what already downloaded
# instead of pulling every tarball again — and the three images share one cache.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# See next.config.ts: the type-check phase is the single largest memory consumer in the
# build and it is the one that killed three deploys on a 2 GB VPS. CI type-checks every
# push, so running it again on the smallest machine in the pipeline buys nothing.
ENV NEXT_SKIP_TYPECHECK=1
# Node sizes its heap from the host's RAM, which on a small VPS lands near 1 GB — and
# then any phase that wants more aborts the whole build instead of paging. Ask for real
# headroom; build_all_images in scripts/deploy/common.sh makes sure swap exists so this
# ceiling is not the physical one.
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# su-exec: drop root → nextjs after any first-run setup in the entrypoint
RUN apk add --no-cache su-exec \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Entrypoint runs as root briefly to chown the sessions volume, then exec as nextjs.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
