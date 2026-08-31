import { redirect } from "next/navigation";
import { getSessionUserForPage } from "@/shared/lib/auth/session-page";

export default async function HomePage() {
  const user = await getSessionUserForPage();
  if (!user) redirect("/login");
  // Master accounts use the System Overview as their home, not the personal
  // file dashboard (which is for regular users' own files).
  redirect(user.role === "master" ? "/admin" : "/dashboard");
}
