/**
 * Key types, lookup, and fallback.
 *
 * `TranslationKey` is derived from the English object, so a misspelled key such
 * as `common.svae` is a compile error. `LocaleMessages` is a deep partial of the same shape, so
 * `id` and `zh-CN` may be incomplete while migration runs — incomplete is
 * reported by `npm run check:i18n`, never rendered as `undefined`.
 */

import { DEFAULT_LOCALE, type Locale } from "./config";
import { interpolate, selectPlural, type TParams } from "./format";
import { en } from "./messages/en";
import { id } from "./messages/id";
import { zhCN } from "./messages/zh-CN";

type EnglishDictionary = typeof en;

/**
 * A plural leaf holds *only* CLDR plural categories. Testing for a `string`
 * `other` alone is not enough: `brain.entityType` has an `other` member (the
 * "Other" entity type) and is a namespace, not a plural.
 */
type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * Dotted leaf paths. Recursion stops at a string and at a plural leaf, so
 * `common.itemCount` is a key and `common.itemCount.one` is not.
 */
type LeafPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : keyof T[K] extends PluralCategory
      ? `${Prefix}${K}`
      : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = LeafPaths<EnglishDictionary>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]>;
};

export type LocaleMessages = DeepPartial<EnglishDictionary>;

export type Translator = (key: TranslationKey, params?: TParams) => string;

const DICTIONARIES: Record<Locale, LocaleMessages> = { en, id, "zh-CN": zhCN };

function lookup(source: unknown, key: string): unknown {
  let node: unknown = source;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const PLURAL_CATEGORIES = new Set<string>(["zero", "one", "two", "few", "many", "other"]);

/**
 * Mirrors `PluralCategory` at runtime: every member must be a plural form, so a
 * namespace that merely happens to contain `other` keeps being walked into.
 */
function isPluralLeaf(node: unknown): node is Record<string, string> {
  if (typeof node !== "object" || node === null) return false;
  const entries = Object.entries(node as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(([name, value]) => PLURAL_CATEGORIES.has(name) && typeof value === "string") &&
    typeof (node as Record<string, unknown>).other === "string"
  );
}

/**
 * Per-key fallback, not per-namespace: a half-translated namespace shows its
 * translated keys and English for the rest, rather than reverting wholesale.
 */
export function resolve(locale: Locale, key: string, count?: number): string {
  const chain: Locale[] =
    locale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [locale, DEFAULT_LOCALE];
  for (const candidate of chain) {
    const node = lookup(DICTIONARIES[candidate], key);
    if (typeof node === "string") return node;
    if (isPluralLeaf(node)) {
      const form = selectPlural(candidate, node, count ?? 0);
      if (typeof form === "string") return form;
    }
  }
  // Visible and greppable. Never `undefined`.
  return key;
}

/** Runtime membership against English, so adding a code needs no call-site edit. */
export function hasKey(key: string): boolean {
  const node = lookup(en, key);
  return typeof node === "string" || isPluralLeaf(node);
}

export function flattenKeys(source: object, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string" || isPluralLeaf(value)) keys.push(path);
    else if (typeof value === "object" && value !== null) {
      keys.push(...flattenKeys(value, path));
    }
  }
  return keys;
}

export function createTranslator(locale: Locale): Translator {
  return (key, params) => {
    const count = typeof params?.count === "number" ? params.count : undefined;
    return interpolate(resolve(locale, key, count), params);
  };
}

/**
 * Turn an API failure into displayable text without ever inspecting the message.
 *
 * Order: a code with a translation, then the server's raw English, then the
 * caller's local fallback key. Branch two is deliberate for v1 — an untranslated
 * server message in English beats a wrong guess, and the backlog tracks it.
 */
export function apiErrorMessage(
  res: { error?: string; code?: string },
  t: Translator,
  fallbackKey: TranslationKey
): string {
  if (res.code) {
    const codeKey = `errors.code.${res.code}`;
    if (hasKey(codeKey)) return t(codeKey as TranslationKey);
  }
  return res.error ?? t(fallbackKey);
}

/**
 * The same registry, for the places that hold a bare code rather than a
 * response: the upload queue puts `RESUME_REQUIRES_FILE` on an item, and the
 * activity timeline replays it long after the request is gone.
 *
 * An unknown value is returned untouched — it is either a code this build has
 * no wording for yet, or a free-text message from an older stored history.
 * Showing it beats showing nothing, and `check:i18n` tracks the backlog.
 */
export function errorCodeMessage(code: string, t: Translator): string {
  const key = `errors.code.${code}`;
  return hasKey(key) ? t(key as TranslationKey) : code;
}
