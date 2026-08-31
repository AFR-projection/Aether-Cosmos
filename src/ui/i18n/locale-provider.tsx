"use client";

/**
 * One subscription for the whole tree.
 *
 * No `mounted` flag, unlike ThemeProvider: that one needs an effect to apply a
 * DOM attribute, whereas the locale attribute is set pre-paint by the boot
 * script and on change by `setLocale`. Skipping the flag also skips a
 * setState-in-effect, which the React Compiler lint rejects.
 */

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

import { DEFAULT_LOCALE, type Locale } from "@/shared/lib/i18n/config";
import { createTranslator, type Translator } from "@/shared/lib/i18n/dictionary";
import { getLocale, getServerLocale, setLocale, subscribe } from "@/shared/lib/i18n/store";

type LocaleContextValue = {
  locale: Locale;
  t: Translator;
  setLocale: (locale: Locale) => void;
};

const FALLBACK: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  t: createTranslator(DEFAULT_LOCALE),
  setLocale: () => {},
};

const LocaleContext = createContext<LocaleContextValue>(FALLBACK);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getLocale, getServerLocale);
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: createTranslator(locale), setLocale }),
    [locale]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Defaults to English rather than throwing. A component rendered outside the
 * provider — a portal, a test, an error boundary fallback — should show English
 * text, not crash the page it was meant to rescue.
 */
export function useLocaleContext(): LocaleContextValue {
  return useContext(LocaleContext);
}
