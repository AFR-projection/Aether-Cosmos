import { describe, it, expect } from "vitest";
import {
  DIRECTIVE_LIMIT,
  renderDirectives,
  resolveDirectives,
} from "./directives";

/**
 * Standing instructions: which rules are in force, and in what order.
 *
 * This is the semantics half of the directive feature, kept free of the database so
 * the rules can be asserted on data rather than on SQL text. Three claims matter more
 * than the rest:
 *
 * - A brain-wide rule survives every project filter. The whole feature is worthless if
 *   naming a project can silently drop "always answer in Indonesian".
 * - A project rule with the same title *replaces* the brain-wide one rather than
 *   joining it. Two contradictory rules in the same prompt is worse than either.
 * - With no project named nothing is dropped at all, because a rule the user believes
 *   is in force must not vanish because a session forgot to say which project it was.
 */

const row = (overrides: Partial<Parameters<typeof resolveDirectives>[0][number]> = {}) => ({
  id: "d1",
  type: "instruction",
  title: "Answer style",
  summary: null,
  content: "Answer in Indonesian",
  projectId: null,
  importance: 0.5,
  confidence: 0.9,
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

describe("resolveDirectives — scope", () => {
  it("keeps brain-wide rules whatever project is active", () => {
    const resolved = resolveDirectives([row({ id: "brain" })], PROJECT);

    expect(resolved.map((item) => item.id)).toEqual(["brain"]);
    expect(resolved[0].scope).toBe("brain");
  });

  it("lets a project rule replace a brain-wide rule of the same name", () => {
    const resolved = resolveDirectives(
      [
        row({ id: "brain", title: "Commit style", content: "Conventional commits" }),
        row({ id: "scoped", title: "commit  STYLE ", projectId: PROJECT, content: "Plain sentences" }),
      ],
      PROJECT
    );

    // Title matching ignores case and collapses whitespace: the user is writing rules,
    // not database keys, and "Commit style" / "commit  STYLE" is the same rule twice.
    expect(resolved.map((item) => item.id)).toEqual(["scoped"]);
  });

  it("leaves a brain-wide rule alone when the project speaks about something else", () => {
    const resolved = resolveDirectives(
      [
        row({ id: "brain", title: "Answer style" }),
        row({ id: "scoped", title: "Commit style", projectId: PROJECT }),
      ],
      PROJECT
    );

    expect(resolved.map((item) => item.id).sort()).toEqual(["brain", "scoped"]);
  });

  it("drops nothing when no project is named", () => {
    const resolved = resolveDirectives(
      [
        row({ id: "brain", title: "Answer style" }),
        row({ id: "scoped", title: "Answer style", projectId: OTHER }),
      ],
      null
    );

    // Both survive, each labelled. Narrowing here would hide a rule from every session
    // that did not happen to name the project it was attached to.
    expect(resolved.map((item) => item.id).sort()).toEqual(["brain", "scoped"]);
    expect(resolved.find((item) => item.id === "scoped")!.scope).toBe("project");
  });

  it("treats a row with no project column as brain-wide", () => {
    // A row that arrived without the column is a brain-wide rule. Reading `undefined`
    // as "scoped" would file every rule under a project that does not exist.
    const missing = { ...row() } as Partial<ReturnType<typeof row>>;
    delete missing.projectId;
    const resolved = resolveDirectives([missing as ReturnType<typeof row>], PROJECT);

    expect(resolved[0].scope).toBe("brain");
  });
});

describe("resolveDirectives — order and shape", () => {
  it("puts project rules first, then the most important", () => {
    const resolved = resolveDirectives(
      [
        row({ id: "low", title: "A", importance: 0.2 }),
        row({ id: "high", title: "B", importance: 0.9 }),
        row({ id: "scoped", title: "C", projectId: PROJECT, importance: 0.1 }),
      ],
      PROJECT
    );

    // The more specific rule leads even when it is the least important one: a project
    // rule exists precisely to be read before the general case.
    expect(resolved.map((item) => item.id)).toEqual(["scoped", "high", "low"]);
  });

  it("keeps equally important rules in the order they arrived", () => {
    const resolved = resolveDirectives(
      [row({ id: "first", title: "A" }), row({ id: "second", title: "B" })],
      null
    );

    expect(resolved.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("prefers the summary over the content, flattened to one line", () => {
    const resolved = resolveDirectives(
      [row({ summary: "  Reply\n  in  Indonesian ", content: "long form" })],
      null
    );

    expect(resolved[0].body).toBe("Reply in Indonesian");
  });

  it("clips a rule that was written as an essay", () => {
    const resolved = resolveDirectives([row({ content: "x".repeat(900) })], null);

    // These land in a system prompt in every session; one runaway rule must not be
    // able to spend the whole budget.
    expect(resolved[0].body.length).toBeLessThanOrEqual(320);
    expect(resolved[0].body.endsWith("…")).toBe(true);
  });

  it("caps how many rules can ride along", () => {
    const many = Array.from({ length: DIRECTIVE_LIMIT + 8 }, (_, i) =>
      row({ id: `d${i}`, title: `Rule ${i}` })
    );

    expect(resolveDirectives(many, null)).toHaveLength(DIRECTIVE_LIMIT);
  });
});

describe("renderDirectives", () => {
  it("marks project rules and leaves brain-wide ones unannotated", () => {
    const resolved = resolveDirectives(
      [row({ id: "brain", title: "Answer style" }), row({ id: "scoped", title: "Commit style", projectId: PROJECT })],
      PROJECT
    );

    const text = renderDirectives(resolved);
    expect(text).toContain("- [project] Commit style:");
    expect(text).toContain("- Answer style: Answer in Indonesian");
    // One line each, so the block's size is predictable from the rule count.
    expect(text.split("\n")).toHaveLength(2);
  });

  it("renders nothing for an empty set rather than an empty heading", () => {
    expect(renderDirectives([])).toBe("");
  });
});
