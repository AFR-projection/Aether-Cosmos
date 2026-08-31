import { NextRequest } from "next/server";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { requireBrainContext } from "@brain/infrastructure/access";
import { requireUuid } from "@brain/infrastructure/http";
import { listBrainTags } from "@brain/application/commands/memory-service";

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/brain/[id]/tags — every tag defined in this brain, alphabetically. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    await requireBrainContext(request, brainId, ["brain.read"]);
    const tags = await listBrainTags(brainId);
    return apiSuccess({ tags });
  } catch (error) {
    return handleApiError(error);
  }
}
