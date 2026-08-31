"use client";

/**
 * The one control that changes the interface language.
 *
 * `segmented` is the Settings row: three cards in the same grid the Theme and
 * Lite mode groups use, so no new CSS is needed.
 *
 * `compact` is the sidebar rail: three short chips (EN / ID / 中文) that fit the
 * 240px expanded width.
 *
 * Both write through `setLocale`, which sets the cookie and notifies every
 * subscriber, so the whole tree re-renders in the new language without a reload.
 */

import { LOCALES, LOCALE_META, useLocale, useSetLocale, useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";

export function LanguageSelector({ variant = "segmented" }: { variant?: "segmented" | "compact" }) {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const t = useT();

  if (variant === "compact") {
    return (
      <div
        className="grid grid-cols-3 gap-1 rounded-lg border border-border/50 bg-muted p-1"
        role="group"
        aria-label={t("language.selectorLabel")}
      >
        {LOCALES.map((value) => (
          <button
            key={value}
            type="button"
            lang={LOCALE_META[value].intlTag}
            className={cn(
              "min-h-[28px] rounded-md px-1 py-1 text-[11px] font-semibold transition-colors",
              value === locale
                ? "bg-accent/15 text-accent-ink"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-pressed={value === locale}
            onClick={() => setLocale(value)}
          >
            {LOCALE_META[value].short}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="set-group">
      <p className="set-group__title" id="set-language-label">
        {t("language.label")}
      </p>
      <p className="set-group__note">{t("language.note")}</p>
      {/* Buttons with aria-pressed, matching the Theme group: these stay plain
          tab stops rather than owing the user arrow-key traversal. */}
      <div className="set-choice" role="group" aria-labelledby="set-language-label">
        {LOCALES.map((value) => (
          <button
            key={value}
            type="button"
            lang={LOCALE_META[value].intlTag}
            className="set-choice__item"
            data-active={value === locale}
            aria-pressed={value === locale}
            onClick={() => setLocale(value)}
          >
            <span className="set-choice__label">{LOCALE_META[value].native}</span>
            {/* The English name is the escape hatch for someone who picked a
                script they cannot read; it is redundant for English itself. */}
            {LOCALE_META[value].native !== LOCALE_META[value].english && (
              <span className="set-choice__hint">{LOCALE_META[value].english}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
