import { describe, expect, it } from "vitest";
import {
  MERGE_AT,
  REPORT_AT,
  bandOf,
  containment,
  duplicateScore,
  normalizeForCompare,
  rankDuplicates,
  tokenOverlap,
  trigramSimilarity,
} from "./similarity";

describe("ingest similarity", () => {
  it("normalizes accents, punctuation, case, and whitespace", () => {
    expect(normalizeForCompare("  Café—DÉPLOY!  ")).toBe("cafe deploy");
  });

  it("recognizes reordered vocabulary and containment", () => {
    expect(tokenOverlap("deploy notes production", "production deploy notes")).toBe(1);
    expect(containment("deploy production", "our production deploy uses Docker on the VPS")).toBe(1);
    expect(trigramSimilarity("notes on deploying", "deploying notes")).toBeGreaterThan(0.5);
  });

  it("classifies threshold boundaries", () => {
    expect(bandOf(MERGE_AT)).toBe("merge");
    expect(bandOf(REPORT_AT)).toBe("report");
    expect(bandOf(REPORT_AT - 0.001)).toBe("distinct");
  });

  it("merges identical claims and keeps unrelated memories distinct", () => {
    const same = duplicateScore(
      { title: "Production deploy", content: "Deploy production with Docker on the VPS." },
      { title: "Production deploy", content: "Deploy production with Docker on the VPS." }
    );
    const unrelated = duplicateScore(
      { title: "Production deploy", content: "Deploy production with Docker on the VPS." },
      { title: "Favorite editor", content: "I prefer Neovim for TypeScript work." }
    );

    expect(same.band).toBe("merge");
    expect(same.score).toBe(1);
    expect(unrelated.band).toBe("distinct");
  });

  it("returns only reportable matches ordered best first", () => {
    const exact = { id: "exact", title: "Backup procedure", content: "Backup PostgreSQL every night." };
    const related = { id: "related", title: "Backup procedures", content: "PostgreSQL backup runs every night." };
    const other = { id: "other", title: "UI colors", content: "Use violet for the primary button." };

    const matches = rankDuplicates(
      { title: "Backup procedure", content: "Backup PostgreSQL every night." },
      [other, related, exact]
    );

    expect(matches.map((match) => match.memory.id)).toEqual(["exact", "related"]);
    expect(matches[0]?.score).toBeGreaterThanOrEqual(matches[1]?.score ?? 0);
  });
});
