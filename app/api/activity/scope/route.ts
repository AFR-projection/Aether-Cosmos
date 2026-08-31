import { requireAuth } from "@/shared/lib/auth/session";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { getOrCreateActivityScope } from "@/shared/lib/activity/activity-scope-server";
import { apiSuccess, handleApiError } from "@/shared/api/response";

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
