import { getSessionUserForPage } from "@/shared/lib/auth/session-page";
import { redirect } from "next/navigation";

export default async function ChangePasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUserForPage();
  if (!user) redirect("/login");
  if (!user.mustChangePassword) redirect("/dashboard");
  return children;
}
