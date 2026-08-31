/**
 * The locale vocabulary. Deliberately import-free: every other i18n module
 * depends on this one, so keeping it a leaf makes cycles impossible.
 */

export const LOCALES = ["en", "id", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

/** English is the source of truth for keys and the fallback for every lookup. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * `intlTag` is what `Intl.*` is constructed with. It is separate from the
 * locale id so a future regional split (id-ID vs id) does not rename keys.
 * `native` is what the selector shows: a language is named in itself.
 * `short` is the two-or-three-character form the compact selector shows where
 * a full name would not fit.
 */
export const LOCALE_META: Record<
  Locale,
  { intlTag: string; english: string; native: string; short: string }
> = {
  en: { intlTag: "en", english: "English", native: "English", short: "EN" },
  id: { intlTag: "id", english: "Indonesian", native: "Indonesia", short: "ID" },
  "zh-CN": { intlTag: "zh-CN", english: "Chinese (Simplified)", native: "中文", short: "中文" },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
