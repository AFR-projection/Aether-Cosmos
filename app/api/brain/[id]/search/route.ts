import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { searchMemories } from "@/lib/brain/memory-service";
import { MEMORY_SEARCH_MAX, MEMORY_TYPES } from "@/lib/brain/constants";

type RouteParams = { params: Promise<{ id: string }> };

const searchSchema = z.object({
  q: z.string().trim().min(1, "Query parameter 'q' is required").max(300),
  type: z.enum(MEMORY_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(MEMORY_SEARCH_MAX).default(20),
  archived: z.coerce.boolean().default(false),
});

/**
 * GET /api/brain/[id]/search?q=… — ranked prefix search, the endpoint an agent
 * calls to recall context. Needs the brain.search scope, not brain.read, so a
 * recall-only agent can be issued a key that cannot enumerate the whole brain.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { userId } = await requireBrainContext(request, brainId, ["brain.search"]);
    await enforceBrainRateLimit(userId, "search", 3);

    const query = searchSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const results = await searchMemories({
      brainId,
      query: query.q,
      type: query.type,
      includeArchived: query.archived,
      limit: query.limit,
    });

    return apiSuccess({ results, query: query.q, count: results.length });
  } catch (error) {
    return handleApiError(error);
  }
}
