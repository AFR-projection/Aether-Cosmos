import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { publishToUser } from "@/lib/realtime/events";
import { logBrainAudit } from "@/lib/brain/audit";
import { listEntities, upsertEntity } from "@/lib/brain/graph-service";
import { BRAIN_ENTITY_TYPES, MEMORY_PAGE_MAX } from "@/lib/brain/constants";

type RouteParams = { params: Promise<{ id: string }> };

const listSchema = z.object({
  type: z.enum(BRAIN_ENTITY_TYPES).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MEMORY_PAGE_MAX).default(50),
});

/** GET /api/brain/[id]/entities — knowledge-graph nodes. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    await requireBrainContext(request, brainId, ["brain.read"]);

    const query = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const entities = await listEntities({ brainId, ...query });

    return apiSuccess({ entities, types: BRAIN_ENTITY_TYPES });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(BRAIN_ENTITY_TYPES).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * POST /api/brain/[id]/entities — create the node, or update it when (name, type)
 * already exists in this brain. Idempotent by design: extraction pipelines send
 * the same entity over and over.
 */
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
    const entity = await upsertEntity({ brainId, ...body });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "entity.upsert",
      resourceType: "brain_entity",
      resourceId: entity.id,
      metadata: { name: entity.name, type: entity.type, agent: principal.agentName },
    });

    await publishToUser(userId, {
      type: "brain_entity_created",
      brainId,
      entityId: entity.id,
      name: entity.name,
    });

    return apiSuccess({ entity }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
