import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { publishToUser } from "@/shared/infrastructure/realtime/events";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { createMemory, listMemories, searchMemories } from "@brain/application/commands/memory-service";
import {
  MEMORY_PAGE_MAX,
  MEMORY_PAGE_SIZE,
  MEMORY_SEARCH_MAX,
  MEMORY_SOURCE_TYPES,
  MEMORY_TYPES,
} from "@brain/domain/constants";

type RouteParams = { params: Promise<{ id: string }> };

const listSchema = z.object({
  q: z.string().max(300).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  tag: z.string().max(50).optional(),
  projectId: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MEMORY_PAGE_MAX).default(MEMORY_PAGE_SIZE),
  archived: z.coerce.boolean().default(false),
});

/**
 * GET /api/brain/[id]/memories — paginated list, or a ranked search when `q` is
 * given. Both branches answer with the same `{ memories, nextCursor }` shape;
 * search simply has no cursor.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { userId } = await requireBrainContext(request, brainId, ["brain.read"]);

    const query = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    if (query.q?.trim()) {
      await enforceBrainRateLimit(userId, "search", 3);
      const results = await searchMemories({
        brainId,
        query: query.q,
        type: query.type,
        projectId: query.projectId,
        includeArchived: query.archived,
        limit: Math.min(query.limit, MEMORY_SEARCH_MAX),
      });
      return apiSuccess({ memories: results, nextCursor: null, query: query.q.trim() });
    }

    const result = await listMemories({
      brainId,
      type: query.type,
      tag: query.tag,
      projectId: query.projectId,
      archived: query.archived,
      limit: query.limit,
      cursor: query.cursor,
    });
    return apiSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  type: z.enum(MEMORY_TYPES).optional(),
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1).max(200_000),
  summary: z.string().trim().max(1000).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceType: z.enum(MEMORY_SOURCE_TYPES).optional(),
  sourceId: z.string().max(200).optional(),
  projectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/brain/[id]/memories — write a new memory. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    const body = createSchema.parse(await request.json());
    const memory = await createMemory({
      brainId,
      principal: { userId, agentId: principal.agentId },
      data: body,
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "memory.create",
      resourceType: "memory",
      resourceId: memory.id,
      metadata: { type: memory.type, title: memory.title, agent: principal.agentName },
    });

    await publishToUser(userId, {
      type: "brain_memory_created",
      brainId,
      memoryId: memory.id,
      title: memory.title,
    });

    return apiSuccess({ memory }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
