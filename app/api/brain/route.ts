import { NextRequest } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainOwner } from "@brain/infrastructure/access";
import { enforceBrainRateLimit } from "@brain/infrastructure/http";
import {
  createBrain,
  getOrCreateDefaultBrain,
  listBrains,
  MAX_BRAINS_PER_USER,
} from "@brain/application/commands/brain-service";

/** GET /api/brain — the caller's brains; the default one is created on first call. */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireBrainOwner(request, ["brain.read"]);

    const existing = await listBrains(userId);
    if (existing.length > 0) {
      return apiSuccess({ brains: existing, maxBrains: MAX_BRAINS_PER_USER });
    }

    const defaultBrain = await getOrCreateDefaultBrain(userId);
    return apiSuccess({ brains: [defaultBrain], maxBrains: MAX_BRAINS_PER_USER });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

/** POST /api/brain — create an additional (non-default) brain. */
export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { sessionUser, userId } = await requireBrainOwner(request, ["brain.write"]);
    await enforceBrainRateLimit(userId, "write");

    const body = createSchema.parse(await request.json());
    const brain = await createBrain(userId, body);

    await logActivity(sessionUser, "edit", {
      resourceType: "brain",
      resourceId: brain.id,
      metadata: { action: "create", name: brain.name },
      ip: getClientIp(request),
    });

    return apiSuccess({ brain }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
