import { redirect } from "next/navigation";
import { AuthError, getSessionUser, type SessionUser } from "@/shared/lib/auth/session";

/** For RSC pages/layouts: maps session security errors to /login?alert=… */
export async function getSessionUserForPage(): Promise<SessionUser | null> {
  try {
    return await getSessionUser();
  } catch (error) {
    if (
      error instanceof AuthError &&
      (error.code === "SESSION_IP_CHANGED" || error.code === "SESSION_INACTIVE")
    ) {
      const params = new URLSearchParams({ alert: error.code });
      if (error.previousIp) params.set("previousIp", error.previousIp);
      if (error.currentIp) params.set("currentIp", error.currentIp);
      redirect(`/login?${params.toString()}`);
    }
    throw error;
  }
}
