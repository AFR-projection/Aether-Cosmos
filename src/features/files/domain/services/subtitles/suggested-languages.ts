import { isSubtitleLanguage } from "./languages";

/**
 * The languages the CC menu offers without being asked for.
 *
 * The full table is 103 entries. A menu that opens onto 103 entries is a menu nobody reads, and the
 * players everybody already knows — YouTube, Netflix — open onto a short list with the rest one step
 * behind. So this is the short list, and the search over everything is the step behind it.
 *
 * **The reader's own interface language always comes first.** Somebody using the app in Indonesian
 * is overwhelmingly likely to want Indonesian subtitles; making them scroll or search for it is the
 * entire problem this file exists to fix.
 *
 * The shortlist is longer than what gets shown, on purpose: languages the file already has are
 * filtered out, and without spare entries a video with three tracks would leave a three-item menu.
 */

/**
 * The candidates, in the order they are offered when no locale reorders them.
 *
 * Chosen by number of speakers and by how much subtitled video actually moves between these
 * languages — not alphabetically, which would put Arabic above English for no reason a viewer
 * benefits from.
 */
export const SUGGESTED_SUBTITLE_LANGUAGES: readonly string[] = [
  "id",
  "en",
  "ja",
  "ko",
  "zh-CN",
  "es",
  "ar",
  "hi",
  "pt-BR",
  "fr",
  "de",
  "ru",
  "th",
  "vi",
  "ms",
];

/** How many rows the menu shows before "more languages". Short enough to take in at a glance. */
const SHOWN = 7;

/**
 * The shortlist for this reader, minus what the file already has.
 *
 * A locale outside the shortlist is still promoted to the front — a Swahili interface should offer
 * Swahili first even though Swahili is not one of the fifteen below. A locale this app has no
 * language entry for is simply skipped rather than rendered as a bare code.
 */
export function suggestedSubtitleLanguages(
  locale: string,
  taken: ReadonlySet<string>
): string[] {
  const ordered = isSubtitleLanguage(locale)
    ? [locale, ...SUGGESTED_SUBTITLE_LANGUAGES.filter((tag) => tag !== locale)]
    : [...SUGGESTED_SUBTITLE_LANGUAGES];

  return ordered.filter((tag) => !taken.has(tag)).slice(0, SHOWN);
}
