/**
 * WCAG contrast audit for the semantic colour tokens in app/globals.css.
 *
 * Reads the real declarations out of the stylesheet rather than a copy, so the
 * numbers can never drift from what ships. Checks the pairs the design system
 * actually renders:
 *
 *   - every `-ink` token, plus --foreground / --muted-foreground, as *text* on
 *     every opaque ground the app paints behind text (AA: 4.5:1)
 *   - white on every solid semantic fill that carries text (AA: 4.5:1)
 *
 * The vivid tokens (--success, --warning, …) are reported for reference but not
 * asserted: they exist to be fills and tints, never ink. See the "Ink variants"
 * comment in globals.css.
 *
 * Run: node scripts/check-contrast.mjs
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = await readFile(join(root, "app", "globals.css"), "utf8");

/** Grabs the declarations of the first block whose selector matches. */
function block(selector) {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`selector not found in globals.css: ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open + 1, close);
  const vars = new Map();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(name, value.trim());
  }
  return vars;
}

/** Resolves `var(--x)` chains down to a literal colour. */
function resolve(vars, name, seen = new Set()) {
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`token not declared: ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (!ref) return raw;
  if (seen.has(name)) throw new Error(`circular token: ${name}`);
  seen.add(name);
  return resolve(vars, ref[1], seen);
}

const channels = (colour) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (!m) throw new Error(`expected an opaque hex colour, got: ${colour}`);
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

const luminance = (colour) => {
  const [r, g, b] = channels(colour).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const AA_TEXT = 4.5;

/** Opaque colours the app paints text on. Translucent layers sit over these. */
const GROUNDS = ["--background", "--background-secondary", "--surface", "--muted"];
const INKS = [
  "--foreground",
  "--muted-foreground",
  "--accent-ink",
  "--success-ink",
  "--warning-ink",
  "--danger-ink",
  "--info-ink",
];
const VIVID = ["--accent", "--accent-light", "--success", "--warning", "--danger", "--info"];
/**
 * Solid fills that carry text or a glyph, paired with the token that sits on
 * them. Every one of these renders somewhere in the app; see the `--on-*`
 * comment in globals.css for why they are not all white.
 */
const ON_FILL = [
  ["--on-accent", "--accent"],
  ["--on-accent", "--accent-dark"],
  ["--on-danger", "--danger-ink"],
  ["--on-warning", "--warning"],
];

const themes = [
  ["light", block(":root {")],
  /* The dark selector only overrides what changes, so anything it omits still
     comes from :root — layer them the way the cascade does. */
  ["dark", new Map([...block(":root {"), ...block('html[data-theme="dark"] {')])],
];

const failures = [];

for (const [name, vars] of themes) {
  console.log(`\n=== ${name} — ink on ground (AA ${AA_TEXT}:1) ===`);
  const grounds = GROUNDS.map((g) => [g, resolve(vars, g)]);
  for (const ink of INKS) {
    const value = resolve(vars, ink);
    const cells = grounds.map(([g, gv]) => {
      const r = contrast(value, gv);
      if (r < AA_TEXT) failures.push(`${name}: ${ink} on ${g} = ${r.toFixed(2)}`);
      return `${g.slice(2)} ${r.toFixed(2)}${r < AA_TEXT ? "!" : ""}`;
    });
    console.log(`  ${ink.slice(2).padEnd(17)} ${cells.join("  ")}`);
  }

  console.log(`  -- glyph on solid fill (AA ${AA_TEXT}:1) --`);
  for (const [ink, fill] of ON_FILL) {
    const r = contrast(resolve(vars, ink), resolve(vars, fill));
    if (r < AA_TEXT) failures.push(`${name}: ${ink} on ${fill} = ${r.toFixed(2)}`);
    console.log(
      `  ${`${ink.slice(2)} on ${fill.slice(2)}`.padEnd(30)} ${r.toFixed(2)}${r < AA_TEXT ? "!" : ""}`
    );
  }

  console.log("  -- vivid tokens (fills/tints only, not asserted) --");
  for (const v of VIVID) {
    const value = resolve(vars, v);
    const cells = grounds.map(([g, gv]) => `${g.slice(2)} ${contrast(value, gv).toFixed(2)}`);
    console.log(`  ${v.slice(2).padEnd(17)} ${cells.join("  ")}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} pair(s) below AA:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("\nOK — every asserted pair clears AA in both themes.");
