import { getSessionUserForPage } from "@/shared/lib/auth/session-page";
import { redirect } from "next/navigation";

/**
 * The graph workspace is a bare authenticated route: no sidebar, no header, no
 * page padding, because the window it opens in exists to show one graph.
 *
 * It sits outside /brain for exactly that reason — everything under /brain renders
 * inside the app shell. The auth check here matches the shell's, and the snapshot
 * endpoint still authorizes the brain id on its own, so the id in the query string
 * grants nothing by being there.
 */
export default async function GraphWorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUserForPage();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  return children;
}
