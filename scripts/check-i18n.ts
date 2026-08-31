/**
 * Translation coverage gate.
 *
 * English is the source of truth. This script reports what `id` and `zh-CN` are
 * missing rather than letting the fallback hide it, and refuses a migrated file
 * that still holds a hardcoded English literal.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { LOCALES } from "@/shared/lib/i18n/config";
import { flattenKeys, hasKey } from "@/shared/lib/i18n/dictionary";
import { en } from "@/shared/lib/i18n/messages/en";
import { id } from "@/shared/lib/i18n/messages/id";
import { zhCN } from "@/shared/lib/i18n/messages/zh-CN";

/** Namespaces whose id and zh-CN coverage must stay at 100%. One line per phase. */
const COMPLETE_NAMESPACES: string[] = [
  "common",
  "errors",
  "nav", // phase 1
  "language", // phase 1
  "settings", // phase 1
  "quickActions", // phase 2
  "palette", // phase 2
  "impersonation", // phase 2
  "notify", // phase 2
  "auth", // phase 3
  "securityAlert", // phase 3
  "errorPages", // phase 3
  "oauth", // phase 3
  "dashboard", // phase 4
  "shares", // phase 4
  "sharedWithMe", // phase 4
  "recycleBin", // phase 4
  "files", // phase 5
  "invitations", // phase 5
  "system", // phase 5
  "brain", // phase 6
  "onboarding",
];

const DICTIONARIES = { id, "zh-CN": zhCN } as const;
const failures: string[] = [];
const englishKeys = flattenKeys(en);
const englishSet = new Set(englishKeys);

function namespaceOf(key: string): string {
  return key.split(".")[0];
}

const NAMESPACES = [...new Set(englishKeys.map(namespaceOf))].sort();

console.log("Coverage (English source of truth)\n");
console.log(
  `  ${"namespace".padEnd(10)} ${"keys".padStart(5)}  ${"id".padStart(7)}  ${"zh-CN".padStart(7)}`
);

for (const ns of NAMESPACES) {
  const keys = englishKeys.filter((key) => namespaceOf(key) === ns);
  const cells: string[] = [];
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    const present = new Set(flattenKeys(dictionary));
    const covered = keys.filter((key) => present.has(key)).length;
    const pct = keys.length === 0 ? 100 : Math.round((covered / keys.length) * 100);
    cells.push(`${pct}%`.padStart(7));
    if (COMPLETE_NAMESPACES.includes(ns) && covered < keys.length) {
      const missing = keys.filter((key) => !present.has(key));
      failures.push(
        `${locale} regressed on complete namespace "${ns}": missing ${missing.length} — ${missing.slice(0, 5).join(", ")}`
      );
    }
  }
  console.log(`  ${ns.padEnd(10)} ${String(keys.length).padStart(5)}  ${cells.join("  ")}`);
}

for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
  for (const key of flattenKeys(dictionary)) {
    if (!englishSet.has(key)) {
      failures.push(`${locale} declares "${key}", which English does not have`);
    }
  }
}

async function collectSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Everything below touches the filesystem. It lives in a function because this
 * repo compiles scripts as CJS, where top-level `await` is not available.
 */
async function main(): Promise<void> {
// The feature-oriented refactor moved the old top-level `components/` tree
// into `src/`. Scan the actual production roots so the gate covers every UI.
const files = [...(await collectSources("app")), ...(await collectSources("src"))];
const sources = new Map<string, string>();
for (const file of files) sources.set(file, await readFile(file, "utf8"));

/** Every `t("…")` literal must exist in English. */
for (const [file, source] of sources) {
  for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
    const key = match[1];
    if (key.startsWith("errors.code.")) continue; // built at runtime, guarded by hasKey
    if (!hasKey(key)) failures.push(`${file}: t("${key}") is not an English key`);
  }
}

/** Attributes whose value a user reads. */
const TEXT_ATTRIBUTES = [
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "aria-valuetext",
  "aria-description",
];

/** Two or more consecutive letters — enough to skip "px", ":", "→", "%s". */
const HAS_WORD = /[A-Za-z]{2,}/;

/** Values that are markup or data rather than prose, even inside a text attribute. */
const NOT_PROSE = /^(?:[a-z]+(?:-[a-z0-9]+)*|[A-Z_]+|https?:\/\/\S+|\/\S*|#[0-9a-fA-F]{3,8})$/;

function isProse(value: string): boolean {
  const text = value.trim();
  if (!HAS_WORD.test(text)) return false;
  if (NOT_PROSE.test(text)) return false;
  if (looksLikeCode(text)) return false;
  return true;
}

/**
 * The JSX-text pattern below is line-based, so a `>` that is a comparison rather
 * than the end of a tag can start a false match: `{(i > 0 || hasRoot) && <Sep />}`
 * reads as the text "0 || hasRoot) &&". Expression syntax, not prose — anything
 * carrying an operator or a closing paren it never opened is code spilling out of
 * a comparison.
 */
function looksLikeCode(text: string): boolean {
  if (/&&|\||=>|[;=]|\b(?:void|Promise)\b/.test(text)) return true;
  const opened = (text.match(/\(/g) ?? []).length;
  const closed = (text.match(/\)/g) ?? []).length;
  return closed > opened;
}

for (const [file, source] of sources) {
  if (!source.includes("useT(")) continue;
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    if (line.includes("i18n-exempt")) return;

    // A JSX text node: `>Save changes<`, but not `>{t("common.save")}<`.
    for (const match of line.matchAll(/>\s*([^<>{}\n]+?)\s*</g)) {
      if (isProse(match[1])) {
        failures.push(`${file}:${index + 1}: hardcoded JSX text "${match[1].trim()}"`);
      }
    }

    // A translatable attribute with a string literal value.
    for (const attribute of TEXT_ATTRIBUTES) {
      for (const match of line.matchAll(new RegExp(`\\b${attribute}="([^"\\n]+)"`, "g"))) {
        if (isProse(match[1])) {
          failures.push(`${file}:${index + 1}: hardcoded ${attribute}="${match[1]}"`);
        }
      }
    }
  });
}

const layout = await readFile("app/layout.tsx", "utf8");
const boot = /const LOCALE_BOOT = `([\s\S]*?)`;/.exec(layout);
if (!boot) {
  failures.push("app/layout.tsx: LOCALE_BOOT not found");
} else {
  const inBoot = [...boot[1].matchAll(/v==='([^']+)'/g)].map((match) => match[1]).sort();
  const configured = [...LOCALES].sort();
  if (inBoot.join(",") !== configured.join(",")) {
    failures.push(
      `LOCALE_BOOT accepts [${inBoot.join(", ")}] but LOCALES is [${configured.join(", ")}]`
    );
  }
}

/** Two namespace keys with identical English text usually mean one of them is redundant. */
for (const ns of NAMESPACES) {
  const seen = new Map<string, string>();
  for (const key of englishKeys.filter((k) => namespaceOf(k) === ns)) {
    const leaf = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
    if (typeof leaf !== "string") continue; // a plural leaf has no single text to compare
    const first = seen.get(leaf);
    if (first) console.log(`  note: "${leaf}" is both ${first} and ${key}`);
    else seen.set(leaf, key);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} i18n failure(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `\nOK — ${englishKeys.length} English keys, ${files.length} files scanned, no leftover literals.`
);
}

main();
