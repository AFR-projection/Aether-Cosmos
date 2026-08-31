import { NextRequest } from "next/server";
import { eq, and, isNull, ilike, gte, lte, desc, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { files } from "@/shared/infrastructure/db/schema";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { cacheGet, cacheSet } from "@/shared/infrastructure/cache/redis";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { MAX_SEARCH_QUERY_LENGTH, timestampParam } from "@/shared/api/query-params";
import { hasSearchTerms, ftsMatch, ftsRank } from "@/shared/lib/search/fts";

/**
 * Every parameter is bounded. `from`/`to`/`cursor` used to be bare strings fed to
 * `new Date(...)`, so `?cursor=banana` produced an Invalid Date, a broken query
 * parameter and a 500; `q` and `mimeType` were unbounded and also went into the
 * Redis cache key; and `page` was unbounded, so `?page=1e9` asked Postgres for a
 * billion-row OFFSET.
 */
const size = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Deep enough for any real result set; an OFFSET past this is not a page. */
const MAX_PAGE = 1000;

const searchSchema = z.object({
  q: z.string().max(MAX_SEARCH_QUERY_LENGTH).optional(),
  mimeType: z.string().max(255).optional(),
  minSize: size.optional(),
  maxSize: size.optional(),
  folderId: z.string().uuid().optional(),
  from: timestampParam.optional(),
  to: timestampParam.optional(),
  cursor: timestampParam.optional(),
  // Offset-based page index, used only for full-text (relevance-ranked) results
  // where a createdAt cursor is not meaningful.
  page: z.coerce.number().int().min(0).max(MAX_PAGE).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["read"]);
    const userId = getEffectiveUserId(sessionUser);
    const params = searchSchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    const cacheKey = `search:${userId}:${JSON.stringify(params)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return apiSuccess(cached);

    const conditions = [eq(files.userId, userId), isNull(files.deletedAt), eq(files.status, "ready")];

    // Non-empty trimmed query enables full-text mode; null means filter-only.
    const query = hasSearchTerms(params.q) ? params.q.trim() : null;
    if (query) {
      // Full-text: match name + note/document text via the generated tsvector.
      conditions.push(ftsMatch(query));
    }
    if (params.mimeType) {
      conditions.push(ilike(files.mimeType, `${params.mimeType}%`));
    }
    if (params.minSize !== undefined) {
      conditions.push(gte(files.sizeBytes, params.minSize));
    }
    if (params.maxSize !== undefined) {
      conditions.push(lte(files.sizeBytes, params.maxSize));
    }
    if (params.folderId) {
      conditions.push(eq(files.folderId, params.folderId));
    }
    if (params.from) {
      conditions.push(gte(files.createdAt, params.from));
    }
    if (params.to) {
      conditions.push(lte(files.createdAt, params.to));
    }

    if (query) {
      // Relevance-ranked results. Rank order is not a monotonic cursor, so we
      // page with LIMIT/OFFSET instead of a createdAt cursor.
      const rank = ftsRank(query);
      const offset = params.page * params.limit;

      const result = await db
        .select()
        .from(files)
        .where(and(...conditions))
        .orderBy(desc(rank), desc(files.createdAt))
        .limit(params.limit + 1)
        .offset(offset);

      const hasMore = result.length > params.limit;
      const items = hasMore ? result.slice(0, params.limit) : result;
      const nextPage = hasMore ? params.page + 1 : null;

      const data = { files: items, nextPage, nextCursor: null, total: items.length };
      await cacheSet(cacheKey, data, 30);
      return apiSuccess(data);
    }

    // Filter-only search (no text query): keep the fast createdAt-cursor path.
    if (params.cursor) {
      conditions.push(lt(files.createdAt, params.cursor));
    }

    const result = await db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(desc(files.createdAt))
      .limit(params.limit + 1);

    const hasMore = result.length > params.limit;
    const items = hasMore ? result.slice(0, params.limit) : result;
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;

    const data = { files: items, nextCursor, nextPage: null, total: items.length };
    await cacheSet(cacheKey, data, 30);
    return apiSuccess(data);
  } catch (error) {
    return handleApiError(error);
  }
}
