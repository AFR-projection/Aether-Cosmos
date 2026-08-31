import { describe, it, expect } from "vitest";
import {
  BRAIN_API_SCOPES,
  brainScopeSatisfied,
  expandBrainScopes,
  DEFAULT_BRAIN_AGENT_SCOPES,
  MEMORY_TYPES,
  isBrainApiScope,
  isMemoryType,
  normalizeBrainScopes,
  normalizeTag,
  normalizeTags,
} from "@brain/domain/constants";
import { keyHasScope } from "@/shared/lib/auth/api-key";

describe("memory type validation", () => {
  it("accepts the enum values the database actually declares", () => {
    expect(MEMORY_TYPES).toContain("fact");
    expect(MEMORY_TYPES).toContain("knowledge");
    for (const type of MEMORY_TYPES) expect(isMemoryType(type)).toBe(true);
  });

  it("rejects anything else, so it never reaches a pgEnum comparison", () => {
    // An unchecked value here becomes Postgres "invalid input value for enum" — a
    // 500 for what should be a 400.
    for (const bad of ["FACT", "fact ", "notes", "", null, 1, {}]) {
      expect(isMemoryType(bad)).toBe(false);
    }
  });
});

describe("brain scopes", () => {
  it("keeps only known scopes and dedupes", () => {
    expect(
      normalizeBrainScopes(["brain.read", "brain.read", "full", "admin:users", "nope"])
    ).toEqual(["brain.read"]);
  });

  it("defaults to read + search + write + link", () => {
    expect(DEFAULT_BRAIN_AGENT_SCOPES).toEqual([
      "brain.read",
      "brain.search",
      "brain.write",
      "brain.link",
    ]);
    for (const scope of DEFAULT_BRAIN_AGENT_SCOPES) {
      expect(isBrainApiScope(scope)).toBe(true);
    }
  });

  it("never hands out a destructive or bulk scope by default (§8)", () => {
    for (const scope of ["brain.delete", "brain.export", "brain.import", "brain.consolidate"]) {
      expect(DEFAULT_BRAIN_AGENT_SCOPES).not.toContain(scope);
    }
  });
});

describe("brainScopeSatisfied — implication table", () => {
  it("treats brain.write as covering brain.link", () => {
    // Keys issued before brain.link existed must keep working with brain_link.
    expect(brainScopeSatisfied(["brain.write"], "brain.link")).toBe(true);
    expect(keyHasScope(["brain.write"], "brain.link")).toBe(true);
  });

  it("does not let write imply anything destructive or bulk", () => {
    for (const scope of ["brain.delete", "brain.export", "brain.import", "brain.consolidate"]) {
      expect(brainScopeSatisfied(["brain.write"], scope)).toBe(false);
    }
  });

  it("brain.full still covers everything, and link does not imply write", () => {
    for (const scope of BRAIN_API_SCOPES) {
      expect(brainScopeSatisfied(["brain.full"], scope)).toBe(true);
    }
    expect(brainScopeSatisfied(["brain.link"], "brain.write")).toBe(false);
  });

  it("expandBrainScopes reports the effective set", () => {
    expect(expandBrainScopes(["brain.write"]).sort()).toEqual(["brain.link", "brain.write"]);
    expect(expandBrainScopes(["brain.full"]).sort()).toEqual([...BRAIN_API_SCOPES].sort());
    expect(expandBrainScopes(["nonsense"])).toEqual([]);
  });
});

describe("keyHasScope — brain.* is a separate namespace from storage scopes", () => {
  it("does NOT let the storage `full` scope reach the brain", () => {
    // Every key already issued with `full` must not silently gain the owner's memories.
    expect(keyHasScope(["full"], "brain.read")).toBe(false);
    expect(keyHasScope(["full"], "brain.write")).toBe(false);
    expect(keyHasScope(["read", "write", "delete", "full"], "brain.export")).toBe(false);
  });

  it("grants only the explicit brain scope", () => {
    expect(keyHasScope(["brain.read"], "brain.read")).toBe(true);
    expect(keyHasScope(["brain.read"], "brain.write")).toBe(false);
    expect(keyHasScope(["brain.full"], "brain.delete")).toBe(true);
  });

  it("does not let a brain scope unlock storage routes either", () => {
    for (const storage of ["read", "upload", "download", "write", "delete"]) {
      expect(keyHasScope([...BRAIN_API_SCOPES], storage)).toBe(false);
    }
  });

  it("still honours master `supreme`", () => {
    expect(keyHasScope(["supreme"], "brain.write")).toBe(true);
  });
});

describe("tag normalization", () => {
  it("trims, collapses whitespace and lowercases", () => {
    expect(normalizeTag("  Work   Notes ")).toBe("work notes");
  });

  it("dedupes case variants and drops empties", () => {
    expect(normalizeTags(["Work", "work", " WORK ", "", "   "])).toEqual(["work"]);
  });
});
