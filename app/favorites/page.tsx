"use client";

import { FileBrowser } from "@files/presentation/components/files/file-browser";
import { Star } from "lucide-react";
import { useT } from "@/shared/lib/i18n";

/**
 * A client component only so the heading can follow the chosen language; the
 * listing below it was already one, so nothing moves off the server that was not
 * already there.
 */
export default function FavoritesPage() {
  const t = useT();
  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 sm:gap-3 text-2xl sm:text-3xl font-bold tracking-tight">
          <Star className="h-6 w-6 sm:h-7 sm:w-7 text-amber-400" />
          {t("nav.favorites")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground/70">{t("files.favorites.subtitle")}</p>
      </div>
      <FileBrowser favorites />
    </div>
  );
}
