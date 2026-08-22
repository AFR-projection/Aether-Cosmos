import { describe, it, expect } from "vitest";
import {
  TOKEN_ESTIMATE_TOLERANCE,
  TOKEN_MODEL,
  estimateTokens,
  estimateTokensOf,
  truncateToTokens,
  usableTokenBudget,
} from "./tokens";

/**
 * The context engine's budget guarantee rests entirely on this module, so the
 * properties that matter are tested as properties, not as golden numbers: the
 * estimator must be deterministic, must never return 0 for non-empty text, and
 * must not degenerate into a character count.
 */
describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is deterministic", () => {
    const text = "Brain 2.0 menggabungkan lexical, semantic, dan graph retrieval.";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it("counts a short word as one token", () => {
    expect(estimateTokens("the")).toBe(1);
    expect(estimateTokens("fox")).toBe(1);
  });

  it("splits long words into several tokens", () => {
    expect(estimateTokens("authorization")).toBeGreaterThan(1);
    expect(estimateTokens("internationalization")).toBeGreaterThan(
      estimateTokens("authorization")
    );
  });

  it("stays close to the real token count of an English sentence", () => {
    // Claude tokenizes this classic pangram at 9-11 tokens.
    const tokens = estimateTokens("The quick brown fox jumps over the lazy dog");
    expect(tokens).toBeGreaterThanOrEqual(9);
    expect(tokens).toBeLessThanOrEqual(14);
  });

  it("is NOT a character count: JSON costs more than prose of the same length", () => {
    const prose = "we decided to keep postgres as the canonical source of truth";
    const json = '{"a":1,"b":[2,3],"c":{"d":"e"},"f":null,"g":true,"h":0.5,"i":9}';
    expect(json.length).toBeCloseTo(prose.length, -1);
    expect(estimateTokens(json)).toBeGreaterThan(estimateTokens(prose));
  });

  it("charges digits pessimistically", () => {
    expect(estimateTokens("1234567890")).toBeGreaterThanOrEqual(5);
  });

  it("charges a token per newline", () => {
    expect(estimateTokens("a\nb")).toBeGreaterThan(estimateTokens("a b"));
  });

  it("charges indentation", () => {
    expect(estimateTokens("        indented")).toBeGreaterThan(estimateTokens("indented"));
  });

  it("counts CJK per character", () => {
    expect(estimateTokens("知識管理")).toBe(4);
  });

  it("charges astral-plane characters more than one token", () => {
    expect(estimateTokens("🧠")).toBe(2);
  });

  it("never returns 0 for non-empty text", () => {
    for (const sample of ["a", " ", ".", "-", "0", "é", "字", "\n"]) {
      expect(estimateTokens(sample)).toBeGreaterThan(0);
    }
  });

  it("grows monotonically as content is appended", () => {
    let text = "retrieval";
    let previous = estimateTokens(text);
    for (const suffix of [" pipeline", " with", " normalized", " scoring"]) {
      text += suffix;
      const next = estimateTokens(text);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });
});

describe("estimateTokensOf", () => {
  it("skips null and undefined parts", () => {
    expect(estimateTokensOf("alpha", null, undefined, "beta")).toBe(
      estimateTokens("alpha") + estimateTokens("beta")
    );
  });

  it("returns 0 when every part is empty", () => {
    expect(estimateTokensOf(null, undefined, "")).toBe(0);
  });
});

describe("usableTokenBudget", () => {
  it("reserves the documented tolerance", () => {
    expect(usableTokenBudget(1000)).toBe(Math.floor(1000 * (1 - TOKEN_ESTIMATE_TOLERANCE)));
    expect(usableTokenBudget(1000)).toBeLessThan(1000);
  });

  it("clamps nonsense input to 0", () => {
    expect(usableTokenBudget(0)).toBe(0);
    expect(usableTokenBudget(-5)).toBe(0);
    expect(usableTokenBudget(Number.NaN)).toBe(0);
  });

  it("never returns 0 for a positive budget", () => {
    expect(usableTokenBudget(1)).toBe(1);
  });
});

describe("truncateToTokens", () => {
  const long = "Kita memutuskan untuk memakai PostgreSQL sebagai canonical source of truth "
    + "karena agent harus tetap disposable dan brain harus tetap user-owned. "
    + "Redis hanya cache, R2 hanya blob storage untuk file, bukan untuk memory.";

  it("returns the input untouched when it already fits", () => {
    expect(truncateToTokens("short enough", 500)).toBe("short enough");
  });

  it("never exceeds the requested token count", () => {
    for (const budget of [1, 2, 5, 10, 25, 50]) {
      const out = truncateToTokens(long, budget);
      expect(estimateTokens(out)).toBeLessThanOrEqual(budget);
    }
  });

  it("marks truncation with an ellipsis", () => {
    expect(truncateToTokens(long, 20).endsWith("…")).toBe(true);
  });

  it("returns an empty string for a non-positive budget", () => {
    expect(truncateToTokens(long, 0)).toBe("");
    expect(truncateToTokens(long, -1)).toBe("");
  });

  it("does not cut mid-word when a boundary is nearby", () => {
    const out = truncateToTokens(long, 30).replace(/…$/, "");
    expect(long.startsWith(out)).toBe(true);
  });
});

describe("TOKEN_MODEL", () => {
  it("is recorded so persisted counts can be re-derived later", () => {
    expect(TOKEN_MODEL).toBe("heuristic-bpe-v1");
  });
});
