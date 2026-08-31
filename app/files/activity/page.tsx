import { ActivityPage } from "@files/presentation/components/files/activity-page";
import { requireAuth } from "@/shared/lib/auth/session";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { getOrCreateActivityScope } from "@/shared/lib/activity/activity-scope-server";
import { redirect } from "next/navigation";

export default async function FileActivityPage() {
  const user = await requireAuth();
  const scope = await getOrCreateActivityScope(getEffectiveUserId(user));
  redirect(`/files/activity/${scope.id}`);
}
