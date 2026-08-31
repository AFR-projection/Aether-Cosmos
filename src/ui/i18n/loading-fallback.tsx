"use client";

import { useT } from "@/shared/lib/i18n";

/**
 * Translated "Loading…" for Suspense fallbacks that live in server components.
 * A fallback renders before its client child mounts, so the text has to come
 * from a client leaf of its own rather than from the boundary's parent.
 */
export function LoadingFallback({ className }: { className?: string }) {
  const t = useT();
  return <span className={className}>{t("common.loading")}</span>;
}
