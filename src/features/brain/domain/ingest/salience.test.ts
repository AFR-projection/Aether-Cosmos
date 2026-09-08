import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_SALIENCE_FLOOR,
  MIN_SALIENCE,
  scoreSalience,
} from "./salience";

describe("ingest salience", () => {
  it("keeps durable English instructions", () => {
    const verdict = scoreSalience("Always run `npm test` before deployment.", "user");

    expect(verdict.score).toBeGreaterThanOrEqual(DIRECTIVE_SALIENCE_FLOOR);
    expect(verdict.signals).toContain("durability");
    expect(verdict.signals).toContain("specificity");
  });

  it("keeps durable Indonesian instructions", () => {
    const verdict = scoreSalience(
      "Mulai sekarang selalu jawab pakai bahasa Indonesia.",
      "user"
    );

    expect(verdict.score).toBeGreaterThanOrEqual(DIRECTIVE_SALIENCE_FLOOR);
    expect(verdict.signals).toContain("durability");
  });

  it("rejects pure pleasantries", () => {
    const verdict = scoreSalience("Makasih bro!", "user");

    expect(verdict.score).toBeLessThan(MIN_SALIENCE);
    expect(verdict.signals).toEqual(expect.arrayContaining(["pleasantry", "too_short"]));
  });

  it("penalizes questions and ephemeral requests", () => {
    const verdict = scoreSalience("Can you run this test again?", "user");

    expect(verdict.score).toBeLessThan(MIN_SALIENCE);
    expect(verdict.signals).toEqual(expect.arrayContaining(["question", "ephemeral"]));
  });

  it("values user facts above assistant restatements", () => {
    const text = "My project uses PostgreSQL 16 on the production server.";

    expect(scoreSalience(text, "user").score).toBeGreaterThan(
      scoreSalience(text, "assistant").score
    );
  });

  it("penalizes source-code dumps", () => {
    const code = [
      "```ts",
      "import { db } from './db';",
      "const value = db.select();",
      "return value;",
      "```",
    ].join("\n");
    const verdict = scoreSalience(code, "assistant");

    expect(verdict.signals).toContain("code_dump");
    expect(verdict.score).toBeLessThan(MIN_SALIENCE);
  });
});
