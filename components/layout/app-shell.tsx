import { getSessionUserForPage } from "@/lib/auth/session-page";
import { redirect } from "next/navigation";
import { ImpersonationBanner } from "./impersonation-banner";
import { CommandPalette } from "./command-palette";
import { ClientShell } from "./client-shell";
import { getOrCreateActivityScope } from "@/lib/activity/activity-scope-server";
import { getEffectiveUserId } from "@/lib/auth/permissions";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getSessionUserForPage();
  if (!user) {
    const { getAdminSettings } = await import("@/lib/admin-settings");
    const settings = await getAdminSettings().catch(() => null);
    if (settings?.maintenanceMode) redirect("/maintenance");
    redirect("/login");
  }

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  const { getAdminSettings } = await import("@/lib/admin-settings");
  const settings = await getAdminSettings();
  if (settings.maintenanceMode && user.role !== "master") {
    redirect("/maintenance");
  }

  const activityScope = await getOrCreateActivityScope(getEffectiveUserId(user));

  return (
    <ClientShell
      user={{
        username: user.username,
        role: user.role,
        quotaBytes: user.quotaBytes,
        usedBytes: user.usedBytes,
        isImpersonating: user.isImpersonating,
      }}
      activityScopeId={activityScope.id}
    >
      <CommandPalette />
      {user.isImpersonating && <ImpersonationBanner />}
      {settings.maintenanceMode && user.role === "master" && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-600 dark:text-amber-400">
          Maintenance mode is ON — regular users are blocked. {settings.maintenanceMessage}
        </div>
      )}
      <div className="p-4 sm:p-6 lg:p-8">{children}</div>
    </ClientShell>
  );
}
