import { NextRequest } from "next/server";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { requireBrainContext } from "@/lib/brain/access";
import { requireUuid } from "@/lib/brain/http";
import { listBrainTags } from "@/lib/brain/memory-service";

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
