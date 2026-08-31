"use client";

/**
 * The only import a UI file needs: `import { useT } from "@/shared/lib/i18n"`.
 * Everything else in @/shared/lib/i18n/ is an implementation detail.
 */

import { useMemo } from "react";

import { useLocaleContext } from "@/ui/i18n/locale-provider";
import type { Locale } from "./config";
import type { Translator } from "./dictionary";
import { formatBytes, formatDate, formatMonthDay, formatNumber, formatTime, formatTimeSeconds, formatTimestamp } from "./format";

export { LOCALES, DEFAULT_LOCALE, LOCALE_META, isLocale } from "./config";
export { activityStatusKey, activityTypeKey } from "./activity-status";
export { apiErrorMessage, createTranslator, errorCodeMessage, hasKey } from "./dictionary";
export { fileTypeKey } from "./file-type";
export { getLocale } from "./store";
export { passwordStrengthKey } from "./password-strength";
export { previewKindKey } from "./preview-kind";
export { relativeTime } from "./relative-time";
export { uploadEtaLabel, uploadStatusKey } from "./upload-status";
export type { Locale } from "./config";
export type { TranslationKey, Translator } from "./dictionary";
export type { TParams } from "./format";

export function useT(): Translator {
  return useLocaleContext().t;
}

export function useLocale(): Locale {
  return useLocaleContext().locale;
}

export function useSetLocale(): (locale: Locale) => void {
  return useLocaleContext().setLocale;
}

/**
 * Locale-bound formatters. Replaces `formatDate`/`formatTime`/`formatBytes`
 * from `@/lib/utils`, which hardcode "id-ID" regardless of the chosen language.
 */
export function useFormat() {
  const locale = useLocale();
  return useMemo(
    () => ({
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(locale, value, options),
      formatDate: (date: Date | string, variant?: "short" | "medium") =>
        formatDate(locale, date, variant),
      formatTime: (date: Date | string) => formatTime(locale, date),
      formatTimeSeconds: (date: Date | string) => formatTimeSeconds(locale, date),
      formatTimestamp: (date: Date | string) => formatTimestamp(locale, date),
      formatMonthDay: (date: Date | string) => formatMonthDay(locale, date),
      formatBytes: (bytes: number) => formatBytes(locale, bytes),
    }),
    [locale]
  );
}
