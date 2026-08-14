import { redirect } from "next/navigation";
import { getSessionUserForPage } from "@/lib/auth/session-page";
import { AppShell } from "@/components/layout/app-shell";
import { AdminTabs } from "@/components/admin/admin-tabs";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUserForPage();
  if (!user) {
    redirect("/login");
  }
  if (user.role !== "master") {
    redirect("/access-denied");
  }
  return (
    <AppShell>
      <AdminTabs>{children}</AdminTabs>
    </AppShell>
  );
}
