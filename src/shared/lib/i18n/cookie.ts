/**
 * The locale cookie, as pure string work.
 *
 * A cookie rather than localStorage because it is the only client-writable
 * store the server can read, which the email and metadata backlog will need.
 * Not httpOnly for the same reason in reverse: the client provider reads it.
 *
 * No `document` here on purpose — vitest runs `environment: "node"`.
 */

import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";

export const LOCALE_COOKIE = "locale";

/** One year, refreshed on every explicit pick. */
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;

export function readLocaleFromCookieString(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    // Exact name match, so `my_locale=id` cannot masquerade as `locale=id`.
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed escape means the value was not written by us.
      return DEFAULT_LOCALE;
    }
    return isLocale(value) ? value : DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

export function buildLocaleCookie(locale: Locale, secure: boolean): string {
  const attributes = [
    `${LOCALE_COOKIE}=${locale}`,
    "Path=/",
    `Max-Age=${LOCALE_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
