import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_MEMORY_TYPES,
  MAX_MINED_TURNS,
  TITLE_CHARS,
  describeCandidate,
  estimateImportance,
  inferMemoryType,
  ingestConfidence,
  mineCandidates,
  requiredSalience,
  synthesizeTitle,
} from "./candidate";
import { DIRECTIVE_SALIENCE_FLOOR } from "./salience";

describe("ingest candidates", () => {
  it.each([
    ["Always run tests before deploy", "instruction"],
    ["I prefer concise answers", "preference"],
    ["We decided to use PostgreSQL", "decision"],
    ["First back up the DB, then deploy", "procedure"],
    ["The server is in Singapore", "fact"],
  ] as const)("infers %s as %s", (text, expected) => {
    expect(inferMemoryType(text)).toBe(expected);
  });

  it("extracts and clips titles instead of inventing them", () => {
    expect(synthesizeTitle("Okay, the production server uses Docker. More detail follows."))
      .toBe("the production server uses Docker.");
    expect(synthesizeTitle("A".repeat(TITLE_CHARS + 20))).toHaveLength(TITLE_CHARS + 1);
    expect(synthesizeTitle("A".repeat(TITLE_CHARS + 20)).endsWith("…")).toBe(true);
  });

  it("only mines the transcript tail and preserves original indexes", () => {
    const turns = Array.from({ length: MAX_MINED_TURNS + 5 }, (_, index) => ({
      role: "user" as const,
      text: `The durable project fact number ${index} remains valid.`,
    }));

    const mined = mineCandidates(turns);

    expect(mined).toHaveLength(MAX_MINED_TURNS);
    expect(mined[0]?.turnIndex).toBe(5);
    expect(mined.at(-1)?.turnIndex).toBe(MAX_MINED_TURNS + 4);
  });

  it("gives directives a higher importance floor and conservative confidence", () => {
    expect(estimateImportance("instruction", 0.8)).toBeGreaterThan(
      estimateImportance("fact", 0.8)
    );
    expect(ingestConfidence(1)).toBeLessThan(0.9);
    expect(ingestConfidence(1)).toBeLessThanOrEqual(0.8);
  });

  it("raises the salience floor for standing directives", () => {
    for (const type of DIRECTIVE_MEMORY_TYPES) {
      expect(requiredSalience(type, 0.1)).toBe(DIRECTIVE_SALIENCE_FLOOR);
    }
    expect(requiredSalience("fact", 0.1)).toBe(0.1);
  });

  it("describes provenance-ready candidates", () => {
    const candidate = describeCandidate(
      "Mulai sekarang selalu gunakan Bahasa Indonesia.",
      "user",
      12
    );

    expect(candidate).toMatchObject({
      type: "instruction",
      role: "user",
      turnIndex: 12,
    });
    expect(candidate.title).toBeTruthy();
    expect(candidate.salience.score).toBeGreaterThanOrEqual(DIRECTIVE_SALIENCE_FLOOR);
  });
});
