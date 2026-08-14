import { ActivityPage } from "@/components/files/activity-page";
import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { getOrCreateActivityScope } from "@/lib/activity/activity-scope-server";
import { redirect } from "next/navigation";

export default async function FileActivityPage() {
  const user = await requireAuth();
  const scope = await getOrCreateActivityScope(getEffectiveUserId(user));
  redirect(`/files/activity/${scope.id}`);
}
