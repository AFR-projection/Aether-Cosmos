import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { getOrCreateActivityScope } from "@/lib/activity/activity-scope-server";
import { apiSuccess, handleApiError } from "@/lib/api/response";

export async function GET() {
  try {
    const user = await requireAuth();
    const scope = await getOrCreateActivityScope(getEffectiveUserId(user));
    return apiSuccess(
      { scopeId: scope.id },
      200,
      { "Cache-Control": "private, no-store" }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
