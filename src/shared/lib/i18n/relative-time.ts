import type { Translator } from "./dictionary";

/**
 * The age of a timestamp, said the way the rest of the app says it.
 *
 * Three screens grew their own copy of this ladder (the audit log, the user table,
 * the user detail page) and they had already started to drift. One ladder, one
 * wording: `common.relative.*`, which the recycle bin and the activity centre
 * also read.
 *
 * `now` is passed in rather than read from `Date.now()` so this stays pure — the
 * caller already ticks a clock in state, and calling `Date.now()` during render
 * would make the output differ between the server pass and the client pass.
 *
 * Not "use client": a plain function with no hooks, importable from anywhere.
 */
export function relativeTime(date: Date | string, now: number, t: Translator): string {
  const then = date instanceof Date ? date.getTime() : new Date(date).getTime();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 5) return t("common.relative.now");
  if (diffSec < 60) return t("common.relative.seconds", { count: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("common.relative.minutes", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("common.relative.hours", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return t("common.relative.days", { count: diffDay });
  return t("common.relative.months", { count: Math.floor(diffDay / 30) });
}
