/**
 * Interpolation, plural selection, and locale-aware number, date and size
 * formatting. Pure: the locale is always a parameter, never ambient state,
 * so the same functions serve the client provider and the node test runner.
 *
 * `Intl` covers everything needed here, so there is no i18n dependency.
 */

import { LOCALE_META, type Locale } from "./config";

export type TParams = Record<string, string | number>;

/** `{name}` only. No nesting, no expressions, nothing to escape. */
const PLACEHOLDER = /\{(\w+)\}/g;

export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  // A single pass, so a substituted value containing `{a}` is never re-scanned.
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

export function pluralCategory(locale: Locale, count: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(LOCALE_META[locale].intlTag);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * `other` is the last resort rather than an error: `id` and `zh-CN` have only
 * one form, so a dictionary that omits `one` for them is correct, not missing.
 */
export function selectPlural(
  locale: Locale,
  forms: Record<string, unknown>,
  count: number
): string | undefined {
  const exact = forms[pluralCategory(locale, count)];
  if (typeof exact === "string") return exact;
  return typeof forms.other === "string" ? forms.other : undefined;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: Locale, options?: Intl.NumberFormatOptions) {
  const cacheKey = `${locale}|${options ? JSON.stringify(options) : ""}`;
  let format = numberFormats.get(cacheKey);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE_META[locale].intlTag, options);
    numberFormats.set(cacheKey, format);
  }
  return format;
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return numberFormat(locale, options).format(value);
}

/** Same two variants as the helper in @/shared/lib/utils.ts, with the locale supplied. */
export function formatDate(
  locale: Locale,
  date: Date | string,
  variant: "short" | "medium" = "medium"
): string {
  const options: Intl.DateTimeFormatOptions =
    variant === "short"
      ? { dateStyle: "short" }
      : { dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat(LOCALE_META[locale].intlTag, options).format(new Date(date));
}

export function formatTime(locale: Locale, date: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE_META[locale].intlTag, {
    timeStyle: "short",
  }).format(new Date(date));
}

/**
 * Day and month with the year left off, for timestamp columns too narrow for a
 * full date. `Intl` also reorders the parts, which is the point: `Aug 29` is
 * `29 Agu` in Indonesian and `8月29日` in Chinese.
 */
export function formatMonthDay(locale: Locale, date: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE_META[locale].intlTag, {
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

/**
 * One audit line's full timestamp, read down to the second. The admin log used
 * to build this with a hardcoded "id-ID"; `Intl` translates the weekday and the
 * month name and reorders the parts, which is the whole reason the log is
 * readable in the reader's language rather than in the server's.
 */
export function formatTimestamp(locale: Locale, date: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE_META[locale].intlTag, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(date));
}

/** Clock time including seconds, for a live tail where the order of two events matters. */
export function formatTimeSeconds(locale: Locale, date: Date | string): string {
  return new Intl.DateTimeFormat(LOCALE_META[locale].intlTag, {
    timeStyle: "medium",
  }).format(new Date(date));
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Units stay untranslated — `KB` is read as `KB` in all three locales — but the
 * decimal mark is not, so `1.5 GB` becomes `1,5 GB` in Indonesian.
 */
export function formatBytes(locale: Locale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${SIZE_UNITS[0]}`;
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    SIZE_UNITS.length - 1
  );
  const value = bytes / 1024 ** exponent;
  return `${formatNumber(locale, value, {
    maximumFractionDigits: exponent === 0 ? 0 : 1,
  })} ${SIZE_UNITS[exponent]}`;
}
