"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";

/**
 * The visible body of `/access-denied`, split out as a client leaf so the page
 * itself stays a static server component: the copy needs `useT()`, the route
 * does not need to be dynamic. Same pattern as [[not-found-card]].
 */
export function AccessDeniedCard() {
  const t = useT();

  return (
    <div className="text-center max-w-md">
      <div className="mb-6 mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-red-500/10 border border-red-500/20">
        <Lock className="h-10 w-10 text-red-500" />
      </div>
      <h1 className="text-2xl font-bold mb-2">{t("errorPages.accessDeniedTitle")}</h1>
      <p className="text-muted-foreground mb-1 text-sm">{t("errorPages.accessDeniedBody")}</p>
      {/* The HTTP status line is protocol text, not prose — it reads the same in
          every locale, which is why the dictionary keeps it in English. */}
      <p className="text-muted-foreground/60 mb-6 text-xs">{t("errorPages.forbiddenCode")}</p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Button asChild variant="secondary">
          <Link href="/dashboard">{t("errorPages.goToDashboard")}</Link>
        </Button>
      </div>
      <p className="mt-6 text-xs text-muted-foreground/50">{t("errorPages.needAccess")}</p>
    </div>
  );
}
