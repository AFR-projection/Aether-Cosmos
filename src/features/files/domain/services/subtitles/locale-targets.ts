import { createHash } from "node:crypto";
import { LOCALES } from "@/shared/lib/i18n/config";
import { UNDETERMINED_LANGUAGE, normalizeLanguageTag } from "./languages";

export type AutomaticSubtitleTarget = {
  readonly language: string;
  readonly satisfiedBySource: boolean;
};

function canonicalComparableTag(value: string): string | null {
  if (value.trim().toLowerCase() === UNDETERMINED_LANGUAGE) return null;
  return normalizeLanguageTag(value);
}

/** Region-aware equality using the same canonical vocabulary as stored subtitle tracks. */
export function subtitleLanguagesEquivalent(left: string, right: string): boolean {
  const a = canonicalComparableTag(left);
  const b = canonicalComparableTag(right);
  return a !== null && b !== null && a === b;
}

/** Stable set hash: caller order and duplicates do not affect reconciliation identity. */
export function subtitleLocaleSetHash(locales: readonly string[] = LOCALES): string {
  const canonical = [...new Set(locales.map((locale) => normalizeLanguageTag(locale)))];
  if (canonical.some((locale) => locale === null)) {
    throw new RangeError("Every app locale must map to a subtitle language");
  }
  const sorted = (canonical as string[]).sort();
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}

/**
 * Derives proactive targets only from app locales. A known equivalent source is already satisfied;
 * an undetermined source intentionally translates every app locale.
 */
export function deriveAutomaticSubtitleTargets(
  sourceLanguage: string,
  locales: readonly string[] = LOCALES
): AutomaticSubtitleTarget[] {
  const seen = new Set<string>();
  const targets: AutomaticSubtitleTarget[] = [];
  for (const locale of locales) {
    const language = normalizeLanguageTag(locale);
    if (!language) throw new RangeError(`App locale ${locale} has no subtitle language`);
    if (seen.has(language)) continue;
    seen.add(language);
    targets.push({
      language,
      satisfiedBySource: subtitleLanguagesEquivalent(sourceLanguage, language),
    });
  }
  return targets;
}
