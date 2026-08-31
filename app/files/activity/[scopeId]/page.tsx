import { ActivityPage } from "@files/presentation/components/files/activity-page";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { requireAuth } from "@/shared/lib/auth/session";
import { getOwnedActivityScope } from "@/shared/lib/activity/activity-scope-server";
import { notFound } from "next/navigation";
import { z } from "zod";

export default async function ScopedFileActivityPage({
  params,
}: {
  params: Promise<{ scopeId: string }>;
}) {
  const user = await requireAuth();
  const { scopeId } = await params;
  if (!z.string().uuid().safeParse(scopeId).success) notFound();
  const scope = await getOwnedActivityScope(scopeId, getEffectiveUserId(user));
  if (!scope) notFound();
  return <ActivityPage scopeId={scope.id} />;
}
