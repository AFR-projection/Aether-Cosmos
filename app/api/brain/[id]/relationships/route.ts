import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { publishToUser } from "@/lib/realtime/events";
import { logBrainAudit } from "@/lib/brain/audit";
import { listRelationships, upsertRelationship } from "@/lib/brain/graph-service";
import { MEMORY_PAGE_MAX } from "@/lib/brain/constants";

type RouteParams = { params: Promise<{ id: string }> };

const listSchema = z.object({
  entityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MEMORY_PAGE_MAX).default(100),
});

/** GET /api/brain/[id]/relationships — edges, optionally only those on one node. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    await requireBrainContext(request, brainId, ["brain.read"]);

    const query = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const relationships = await listRelationships({ brainId, ...query });

    // Entity ids are included, not just names: the graph view needs them to draw
    // edges between nodes it fetched from /entities.
    return apiSuccess({
      relationships: relationships.map((relationship) => ({
        id: relationship.id,
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
        source: relationship.sourceName,
        target: relationship.targetName,
        type: relationship.relationshipType,
        confidence: relationship.confidence,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  sourceEntityId: z.string().uuid(),
  targetEntityId: z.string().uuid(),
  relationshipType: z.string().trim().min(1).max(100),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * POST /api/brain/[id]/relationships — link two nodes of THIS brain. Re-posting the
 * same (source, target, type) updates confidence/metadata instead of duplicating.
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
    const relationship = await upsertRelationship({ brainId, ...body });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "relationship.upsert",
      resourceType: "brain_relationship",
      resourceId: relationship.id,
      metadata: {
        relationshipType: relationship.relationshipType,
        agent: principal.agentName,
      },
    });

    await publishToUser(userId, {
      type: "brain_relationship_created",
      brainId,
      relationshipId: relationship.id,
      relationshipType: relationship.relationshipType,
    });

    return apiSuccess({ relationship }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
