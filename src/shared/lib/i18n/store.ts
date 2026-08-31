"use client";

/**
 * The locale as an external store, mirroring @/shared/lib/system/lite-mode.ts: a plain
 * getter, a window event, and a subscribe that adds one listener. No React
 * state, so `useSyncExternalStore` can read it during hydration and after.
 */

import { DEFAULT_LOCALE, type Locale } from "./config";
import { buildLocaleCookie, LOCALE_COOKIE, readLocaleFromCookieString } from "./cookie";

/** Kept in sync with the inline boot script in app/layout.tsx. */
export const LOCALE_EVENT = "locale-change";

export function getLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  return readLocaleFromCookieString(document.cookie);
}

/**
 * Pinned to English on purpose. Server HTML must not vary by cookie, or the
 * prerendered pages stop being reusable and every visitor risks a hydration
 * mismatch. The correction happens one render after hydration.
 */
export function getServerLocale(): Locale {
  return DEFAULT_LOCALE;
}

export function setLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.cookie = buildLocaleCookie(locale, window.location.protocol === "https:");
  const root = document.documentElement;
  root.lang = locale;
  root.dataset.locale = locale;
  window.dispatchEvent(new Event(LOCALE_EVENT));
}

export function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(LOCALE_EVENT, onChange);
  return () => window.removeEventListener(LOCALE_EVENT, onChange);
}

/** Test and sign-out helper: drop the preference and fall back to English. */
export function resetLocale(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  document.documentElement.lang = DEFAULT_LOCALE;
  delete document.documentElement.dataset.locale;
  window.dispatchEvent(new Event(LOCALE_EVENT));
}
