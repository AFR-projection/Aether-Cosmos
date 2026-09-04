import { describe, it, expect } from "vitest";
import {
  checkEntityName,
  entityNameSchema,
  ENTITY_NAME_MAX,
} from "@/shared/lib/security/entity-name";

/**
 * A folder name is a path segment, so the validator's job is to keep it one.
 *
 * `materialized_path` is built by concatenation (`/parent/child/`) and every
 * subtree operation — rename, move, trash, restore, purge, the paste walk —
 * selects by prefix on that string. A name holding a `/` forges a path: `a/b` at
 * the root writes `/a/b/`, which no query can tell apart from a real `b` inside a
 * real `a`. The same strings become ZIP entry names on export and the label a
 * public share page renders.
 *
 * Written with `String.fromCharCode` rather than literals so this file cannot be
 * broken by an editor that honours the very characters under test.
 */

const RTL_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const NUL = String.fromCharCode(0);

function reasonFor(raw: string): string {
  const result = checkEntityName(raw);
  if (result.ok) throw new Error(`expected ${JSON.stringify(raw)} to be refused`);
  return result.reason;
}

describe("checkEntityName keeps a name from forging a path", () => {
  it("refuses a forward slash", () => {
    expect(reasonFor("a/b")).toMatch(/slash/i);
  });

  it("refuses a backslash, which Windows clients send as a separator", () => {
    expect(reasonFor("a\\b")).toMatch(/slash/i);
  });

  it("refuses the relative segments", () => {
    expect(reasonFor(".")).toMatch(/"\."/);
    expect(reasonFor("..")).toMatch(/"\."/);
  });

  it("allows a leading dot, which is a normal hidden name", () => {
    expect(checkEntityName(".env")).toEqual({ ok: true, name: ".env" });
  });

  it("allows a dot inside the name", () => {
    expect(checkEntityName("report.final.pdf")).toEqual({
      ok: true,
      name: "report.final.pdf",
    });
  });

  it("refuses a trailing dot, which Windows drops on extraction", () => {
    // `notes.` and `notes` would unzip into the same entry and one would be lost.
    expect(reasonFor("notes.")).toMatch(/dot/i);
  });
});

describe("checkEntityName keeps a name honest on screen", () => {
  it("refuses a right-to-left override", () => {
    // Renders as "exe.png" in the file list and on the share page.
    expect(reasonFor(`invoice${RTL_OVERRIDE}gnp.exe`)).toMatch(/invisible|direction/i);
  });

  it("refuses a zero-width space", () => {
    expect(reasonFor(`Payroll${ZERO_WIDTH_SPACE}`)).toMatch(/invisible|direction/i);
  });

  it("refuses a byte-order mark inside the name", () => {
    expect(reasonFor(`Re${BOM}port`)).toMatch(/invisible|direction/i);
  });

  it("trims a leading or trailing byte-order mark away instead of refusing", () => {
    // ECMAScript counts U+FEFF as whitespace, so `trim()` removes it at the edges —
    // the invisible character never reaches the database either way, and refusing a
    // name that is about to become legal would only confuse whoever pasted it.
    expect(checkEntityName(`${BOM}Report`)).toEqual({ ok: true, name: "Report" });
    expect(checkEntityName(`Report${BOM}`)).toEqual({ ok: true, name: "Report" });
  });

  it("still allows the joiners that Arabic, Indic and emoji names need", () => {
    // ZWNJ and ZWJ are load-bearing script characters, not spoofing tools.
    expect(checkEntityName(`می${ZWNJ}خوانم`).ok).toBe(true);
    expect(checkEntityName(`family ${"\u{1F468}"}${ZWJ}${"\u{1F469}"}`).ok).toBe(true);
  });

  it("allows the punctuation Windows forbids but the tree does not care about", () => {
    // Refusing these would reject names people already have; none of them break a
    // path prefix, an R2 key or a ZIP entry.
    for (const name of ["a:b", "what?", 'say "hi"', "a*b", "x<y>z", "a|b"]) {
      expect(checkEntityName(name)).toEqual({ ok: true, name });
    }
  });

  it("allows the LIKE wildcards, which are escaped at the query instead", () => {
    // `escapeLike` is what makes a folder literally named `%` safe.
    expect(checkEntityName("%")).toEqual({ ok: true, name: "%" });
    expect(checkEntityName("100_%")).toEqual({ ok: true, name: "100_%" });
  });
});

describe("checkEntityName rejects what the database cannot store", () => {
  it("refuses a NUL byte, which Postgres answers with a 500", () => {
    expect(reasonFor(`bad${NUL}name`)).toMatch(/control/i);
  });

  it("refuses a newline and a tab", () => {
    expect(reasonFor("two\nlines")).toMatch(/control/i);
    expect(reasonFor("two\tcolumns")).toMatch(/control/i);
  });

  it("refuses an empty name, before and after trimming", () => {
    expect(reasonFor("")).toMatch(/empty/i);
    expect(reasonFor("    ")).toMatch(/empty/i);
  });

  it("measures the length after trimming", () => {
    const atLimit = "x".repeat(ENTITY_NAME_MAX);
    expect(checkEntityName(`  ${atLimit}  `)).toEqual({ ok: true, name: atLimit });
    expect(reasonFor("x".repeat(ENTITY_NAME_MAX + 1))).toMatch(/longer/i);
  });

  it("returns the trimmed name, so the caller writes what was validated", () => {
    // The route stores `result.name`; validating one string and inserting another
    // is how a trailing space survives into a path.
    expect(checkEntityName("  Quarterly Report  ")).toEqual({
      ok: true,
      name: "Quarterly Report",
    });
  });
});

describe("entityNameSchema is the same rules as a Zod field", () => {
  it("parses to the trimmed name", () => {
    expect(entityNameSchema.parse("  Photos  ")).toBe("Photos");
  });

  it("fails with the reason the checker gave", () => {
    const result = entityNameSchema.safeParse("a/b");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/slash/i);
  });

  it("accepts surrounding whitespace that trims down to a legal length", () => {
    const atLimit = "x".repeat(ENTITY_NAME_MAX);
    expect(entityNameSchema.parse(`   ${atLimit}   `)).toBe(atLimit);
  });

  it("refuses a name that is over the limit once trimmed", () => {
    expect(entityNameSchema.safeParse("x".repeat(ENTITY_NAME_MAX + 1)).success).toBe(false);
  });

  it("refuses a whitespace-only name rather than storing a blank", () => {
    expect(entityNameSchema.safeParse("   ").success).toBe(false);
  });
});
