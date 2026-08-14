import { getSessionUserForPage } from "@/lib/auth/session-page";
import { redirect } from "next/navigation";

/**
 * Authenticated shell for the dedicated Activity Center route.
 * It intentionally does not use AppShell, so the popup has no file-manager
 * navigation, sidebar, or page chrome.
 */
export async function ActivityCenterLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUserForPage();
  if (!user) {
    const { getAdminSettings } = await import("@/lib/admin-settings");
    const settings = await getAdminSettings().catch(() => null);
    if (settings?.maintenanceMode) redirect("/maintenance");
    redirect("/login");
  }

  if (user.mustChangePassword) redirect("/change-password");

  const { getAdminSettings } = await import("@/lib/admin-settings");
  const settings = await getAdminSettings();
  if (settings.maintenanceMode && user.role !== "master") redirect("/maintenance");

  return (
    <div className="min-h-dvh bg-background">
      <main className="min-h-dvh w-full">{children}</main>
    </div>
  );
}
