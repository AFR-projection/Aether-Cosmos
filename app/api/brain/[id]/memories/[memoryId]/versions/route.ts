import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { requireBrainContext } from "@brain/infrastructure/access";
import { requireUuid } from "@brain/infrastructure/http";
import { getMemoryVersions } from "@brain/application/commands/memory-service";
import { MEMORY_PAGE_MAX } from "@brain/domain/constants";

type RouteParams = { params: Promise<{ id: string; memoryId: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MEMORY_PAGE_MAX).default(50),
});

/** GET /api/brain/[id]/memories/[memoryId]/versions — newest version first. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, memoryId } = await params;
    const brainId = requireUuid(id, "id");
    await requireBrainContext(request, brainId, ["brain.read"]);

    const { limit } = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const versions = await getMemoryVersions({
      brainId,
      memoryId: requireUuid(memoryId, "memoryId"),
      limit,
    });

    return apiSuccess({ versions });
  } catch (error) {
    return handleApiError(error);
  }
}
