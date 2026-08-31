"use client";

import { apiFetch } from "@/shared/api/client";
import { useRouter } from "next/navigation";
import { useT } from "@/shared/lib/i18n";

export function ImpersonationBanner() {
  const router = useRouter();
  const t = useT();

  async function endImpersonation() {
    await apiFetch("/api/auth/impersonate", { method: "DELETE" });
    router.push("/admin/users");
    router.refresh();
  }

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-2 text-center text-sm text-amber-600 dark:text-amber-400">
      {t("impersonation.notice")}{" "}
      <button type="button" onClick={endImpersonation} className="underline font-medium">
        {t("impersonation.end")}
      </button>
    </div>
  );
}
