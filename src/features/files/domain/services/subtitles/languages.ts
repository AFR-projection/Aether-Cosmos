/**
 * Every language subtitles can be produced in, and how to name one.
 *
 * A language is named in itself. That is the same rule `@/shared/lib/i18n/config.ts` follows
 * for the interface locales, and it is why `native` is data here rather than a dictionary key:
 * "日本語" is not a translation of "Japanese", it is what the language is called, and a reader
 * scanning the picker for their own language is looking for the word they would write.
 *
 * The list is Whisper's coverage, which is what bounds what the transcription provider can
 * actually recognise. Translation targets are not bounded by that — an LLM will translate into
 * anything — but offering a target that can never be a *source* would be a picker that lies
 * about half its entries, so both directions share one table.
 *
 * Ordered by English name, and `languages.test.ts` proves it: the picker renders the array as
 * it stands, so the order is a property of this file rather than of the component.
 */

export type SubtitleLanguage = {
  /** BCP-47, exactly as it will be written into `<track srclang>` and stored in the database. */
  readonly tag: string;
  /** Stable identity for lookups and for an English-speaking operator reading a log line. */
  readonly english: string;
  /** What the language calls itself. This is what the picker shows. */
  readonly native: string;
  /**
   * Written right to left. The overlay needs this: `dir="auto"` gets a line of Arabic right
   * but not a line of Arabic that opens with a Latin name, which is common in subtitles.
   */
  readonly rtl?: true;
};

export const SUBTITLE_LANGUAGES: readonly SubtitleLanguage[] = [
  { tag: "af", english: "Afrikaans", native: "Afrikaans" },
  { tag: "sq", english: "Albanian", native: "Shqip" },
  { tag: "am", english: "Amharic", native: "አማርኛ" },
  { tag: "ar", english: "Arabic", native: "العربية", rtl: true },
  { tag: "hy", english: "Armenian", native: "Հայերեն" },
  { tag: "as", english: "Assamese", native: "অসমীয়া" },
  { tag: "az", english: "Azerbaijani", native: "Azərbaycan" },
  { tag: "ba", english: "Bashkir", native: "Башҡортса" },
  { tag: "eu", english: "Basque", native: "Euskara" },
  { tag: "be", english: "Belarusian", native: "Беларуская" },
  { tag: "bn", english: "Bengali", native: "বাংলা" },
  { tag: "bs", english: "Bosnian", native: "Bosanski" },
  { tag: "br", english: "Breton", native: "Brezhoneg" },
  { tag: "bg", english: "Bulgarian", native: "Български" },
  { tag: "my", english: "Burmese", native: "မြန်မာ" },
  { tag: "yue", english: "Cantonese", native: "粵語" },
  { tag: "ca", english: "Catalan", native: "Català" },
  { tag: "zh-CN", english: "Chinese (Simplified)", native: "简体中文" },
  { tag: "zh-TW", english: "Chinese (Traditional)", native: "繁體中文" },
  { tag: "hr", english: "Croatian", native: "Hrvatski" },
  { tag: "cs", english: "Czech", native: "Čeština" },
  { tag: "da", english: "Danish", native: "Dansk" },
  { tag: "nl", english: "Dutch", native: "Nederlands" },
  { tag: "en", english: "English", native: "English" },
  { tag: "et", english: "Estonian", native: "Eesti" },
  { tag: "fo", english: "Faroese", native: "Føroyskt" },
  { tag: "fi", english: "Finnish", native: "Suomi" },
  { tag: "fr", english: "French", native: "Français" },
  { tag: "gl", english: "Galician", native: "Galego" },
  { tag: "ka", english: "Georgian", native: "ქართული" },
  { tag: "de", english: "German", native: "Deutsch" },
  { tag: "el", english: "Greek", native: "Ελληνικά" },
  { tag: "gu", english: "Gujarati", native: "ગુજરાતી" },
  { tag: "ht", english: "Haitian Creole", native: "Kreyòl ayisyen" },
  { tag: "ha", english: "Hausa", native: "Hausa" },
  { tag: "haw", english: "Hawaiian", native: "ʻŌlelo Hawaiʻi" },
  { tag: "he", english: "Hebrew", native: "עברית", rtl: true },
  { tag: "hi", english: "Hindi", native: "हिन्दी" },
  { tag: "hu", english: "Hungarian", native: "Magyar" },
  { tag: "is", english: "Icelandic", native: "Íslenska" },
  { tag: "id", english: "Indonesian", native: "Indonesia" },
  { tag: "it", english: "Italian", native: "Italiano" },
  { tag: "ja", english: "Japanese", native: "日本語" },
  { tag: "jv", english: "Javanese", native: "Basa Jawa" },
  { tag: "kn", english: "Kannada", native: "ಕನ್ನಡ" },
  { tag: "kk", english: "Kazakh", native: "Қазақша" },
  { tag: "km", english: "Khmer", native: "ភាសាខ្មែរ" },
  { tag: "ko", english: "Korean", native: "한국어" },
  { tag: "lo", english: "Lao", native: "ລາວ" },
  { tag: "la", english: "Latin", native: "Latina" },
  { tag: "lv", english: "Latvian", native: "Latviešu" },
  { tag: "ln", english: "Lingala", native: "Lingála" },
  { tag: "lt", english: "Lithuanian", native: "Lietuvių" },
  { tag: "lb", english: "Luxembourgish", native: "Lëtzebuergesch" },
  { tag: "mk", english: "Macedonian", native: "Македонски" },
  { tag: "mg", english: "Malagasy", native: "Malagasy" },
  { tag: "ms", english: "Malay", native: "Melayu" },
  { tag: "ml", english: "Malayalam", native: "മലയാളം" },
  { tag: "mt", english: "Maltese", native: "Malti" },
  { tag: "mi", english: "Maori", native: "Māori" },
  { tag: "mr", english: "Marathi", native: "मराठी" },
  { tag: "mn", english: "Mongolian", native: "Монгол" },
  { tag: "ne", english: "Nepali", native: "नेपाली" },
  { tag: "no", english: "Norwegian", native: "Norsk" },
  { tag: "nn", english: "Norwegian Nynorsk", native: "Nynorsk" },
  { tag: "ny", english: "Nyanja", native: "Chichewa" },
  { tag: "oc", english: "Occitan", native: "Occitan" },
  { tag: "ps", english: "Pashto", native: "پښتو", rtl: true },
  { tag: "fa", english: "Persian", native: "فارسی", rtl: true },
  { tag: "pl", english: "Polish", native: "Polski" },
  { tag: "pt", english: "Portuguese", native: "Português" },
  { tag: "pt-BR", english: "Portuguese (Brazil)", native: "Português (Brasil)" },
  { tag: "pa", english: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { tag: "ro", english: "Romanian", native: "Română" },
  { tag: "ru", english: "Russian", native: "Русский" },
  { tag: "sa", english: "Sanskrit", native: "संस्कृतम्" },
  { tag: "sr", english: "Serbian", native: "Српски" },
  { tag: "sn", english: "Shona", native: "ChiShona" },
  { tag: "sd", english: "Sindhi", native: "سنڌي", rtl: true },
  { tag: "si", english: "Sinhala", native: "සිංහල" },
  { tag: "sk", english: "Slovak", native: "Slovenčina" },
  { tag: "sl", english: "Slovenian", native: "Slovenščina" },
  { tag: "so", english: "Somali", native: "Soomaali" },
  { tag: "es", english: "Spanish", native: "Español" },
  { tag: "su", english: "Sundanese", native: "Basa Sunda" },
  { tag: "sw", english: "Swahili", native: "Kiswahili" },
  { tag: "sv", english: "Swedish", native: "Svenska" },
  { tag: "tl", english: "Tagalog", native: "Tagalog" },
  { tag: "tg", english: "Tajik", native: "Тоҷикӣ" },
  { tag: "ta", english: "Tamil", native: "தமிழ்" },
  { tag: "tt", english: "Tatar", native: "Татарча" },
  { tag: "te", english: "Telugu", native: "తెలుగు" },
  { tag: "th", english: "Thai", native: "ไทย" },
  { tag: "bo", english: "Tibetan", native: "བོད་སྐད་" },
  { tag: "tr", english: "Turkish", native: "Türkçe" },
  { tag: "tk", english: "Turkmen", native: "Türkmen" },
  { tag: "uk", english: "Ukrainian", native: "Українська" },
  { tag: "ur", english: "Urdu", native: "اردو", rtl: true },
  { tag: "uz", english: "Uzbek", native: "Oʻzbek" },
  { tag: "vi", english: "Vietnamese", native: "Tiếng Việt" },
  { tag: "cy", english: "Welsh", native: "Cymraeg" },
  { tag: "yi", english: "Yiddish", native: "ייִדיש", rtl: true },
  { tag: "yo", english: "Yoruba", native: "Yorùbá" },
];

/**
 * BCP-47's own code for "not determined".
 *
 * A transcription track exists — and shows its progress — before anybody knows what language the
 * audio is in, so it is created carrying this and renamed once the provider reports a detection.
 * Deliberately NOT a member of {@link SUBTITLE_LANGUAGES}: it must never appear in the picker, and
 * {@link normalizeLanguageTag} must never produce it, or a real detection could be overwritten by
 * a placeholder.
 */
export const UNDETERMINED_LANGUAGE = "und";

const BY_TAG = new Map(SUBTITLE_LANGUAGES.map((language) => [language.tag, language]));const BY_LOWER_TAG = new Map(
  SUBTITLE_LANGUAGES.map((language) => [language.tag.toLowerCase(), language])
);
const BY_ENGLISH = new Map(
  SUBTITLE_LANGUAGES.map((language) => [language.english.toLowerCase(), language])
);

/**
 * Names a provider uses that this table spells differently.
 *
 * Whisper reports the detected language as an English word from its own vocabulary, and that
 * vocabulary is not the one here: it says "chinese" without saying which script, "bangla" for
 * Bengali, "pushto" for Pashto, "letzeburgesch" for Luxembourgish. Every entry below is a name
 * a provider actually emits — this is a compatibility table, not a thesaurus, so a name that
 * no provider produces does not belong in it.
 *
 * "chinese" and "mandarin" resolve to Simplified. That is a choice rather than a fact: Whisper
 * cannot tell the scripts apart from audio, Simplified is the far more common target, and a
 * reader who wanted Traditional can pick it directly.
 */
const ALIASES: Readonly<Record<string, string>> = {
  chinese: "zh-CN",
  mandarin: "zh-CN",
  bangla: "bn",
  burmese: "my",
  myanmar: "my",
  castilian: "es",
  farsi: "fa",
  filipino: "tl",
  flemish: "nl",
  haitian: "ht",
  letzeburgesch: "lb",
  moldavian: "ro",
  moldovan: "ro",
  nynorsk: "nn",
  panjabi: "pa",
  pushto: "ps",
  sinhalese: "si",
  valencian: "ca",
  "brazilian portuguese": "pt-BR",
  "modern greek": "el",
  "serbo-croatian": "sr",
};

/** Whether a value is a tag this table carries, spelled exactly as this table spells it. */
export function isSubtitleLanguage(value: unknown): value is string {
  return typeof value === "string" && BY_TAG.has(value);
}

/** The record for a canonical tag, or `undefined`. */
export function findSubtitleLanguage(tag: string): SubtitleLanguage | undefined {
  return BY_TAG.get(tag);
}

/**
 * Whatever a client or a provider called a language, as a tag this table carries — or `null`.
 *
 * Four inputs are accepted, in the order they are tried: the exact tag, the tag in the wrong
 * case, an English name (which is how Whisper reports what it detected), and finally the base
 * language of a regional tag this table does not carry. That last step is what makes `en-US`
 * usable without listing every region of every language: a browser or a caller naming a region
 * we have no separate entry for gets the language, not a refusal. An exact regional match
 * always wins over it, so `pt-BR` stays Brazilian.
 *
 * Never invents a tag. A language nothing here recognises is `null`, because a `<track srclang>`
 * carrying a code no parser knows is worse than a track with no language at all.
 */
export function normalizeLanguageTag(value: string): string | null {
  const raw = value.trim().replace(/_/g, "-");
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();

  const exact = BY_LOWER_TAG.get(lower);
  if (exact) return exact.tag;

  const named = BY_ENGLISH.get(lower);
  if (named) return named.tag;

  const alias = ALIASES[lower];
  if (alias) return alias;

  const base = BY_LOWER_TAG.get(lower.split("-")[0]);
  return base ? base.tag : null;
}

/**
 * A language named in itself, for the picker and the track list.
 *
 * An unrecognised tag is shown as itself. A track can only hold a tag this table produced, so
 * this should be unreachable — but printing the code is how an operator finds out that it
 * happened, and printing nothing is how it stays hidden.
 */
export function subtitleLanguageLabel(tag: string): string {
  return BY_TAG.get(tag)?.native ?? tag;
}

/** Whether text in this language runs right to left, for the overlay's `dir`. */
export function isRtlLanguage(tag: string): boolean {
  return BY_TAG.get(tag)?.rtl === true;
}
