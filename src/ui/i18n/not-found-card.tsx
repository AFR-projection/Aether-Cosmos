"use client";

import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";

/**
 * The visible body of `app/not-found.tsx`, split out as a client leaf so the
 * not-found route stays a static server component while its copy still reads
 * from the dictionary. Same pattern as [[access-denied-card]].
 */
export function NotFoundCard() {
  const t = useT();

  return (
    <div className="text-center max-w-md">
      <div className="mb-6 mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
        <FileQuestion className="h-10 w-10 text-amber-500" />
      </div>
      <h1 className="text-2xl font-bold mb-2">{t("errorPages.notFoundTitle")}</h1>
      <p className="text-muted-foreground mb-6 text-sm">{t("errorPages.notFoundBody")}</p>
      <Button asChild variant="default">
        <Link href="/dashboard">{t("errorPages.goToDashboard")}</Link>
      </Button>
    </div>
  );
}
