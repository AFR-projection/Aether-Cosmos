import { describe, it, expect } from "vitest";
import { tiptapToPlainText } from "@/shared/lib/search/tiptap-text";

describe("tiptapToPlainText", () => {
  it("extracts text from a simple paragraph doc", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe("Hello world");
  });

  it("joins text across multiple blocks with a space", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe("First line Second line");
  });

  it("walks nested marks and inline nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold ", marks: [{ type: "bold" }] },
            { type: "text", text: "and italic" },
          ],
        },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe("bold and italic");
  });

  it("collapses excess whitespace", () => {
    const doc = {
      type: "doc",
      content: [{ type: "text", text: "a\n\n  b   c" }],
    };
    expect(tiptapToPlainText(doc)).toBe("a b c");
  });

  it("returns empty string for null / non-object / empty input", () => {
    expect(tiptapToPlainText(null)).toBe("");
    expect(tiptapToPlainText(undefined)).toBe("");
    expect(tiptapToPlainText("just a string")).toBe("");
    expect(tiptapToPlainText({})).toBe("");
    expect(tiptapToPlainText({ type: "doc", content: [] })).toBe("");
  });

  it("ignores non-string text fields and malformed content arrays", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "text", text: 123 },
        { type: "paragraph", content: "not-an-array" },
        { type: "paragraph", content: [{ type: "text", text: "valid" }] },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe("valid");
  });

  it("does not blow the stack on deeply nested content", () => {
    // Build a doc nested deeper than MAX_DEPTH — should return without throwing.
    let node: { type: string; content: unknown[] } = { type: "text", content: [] };
    for (let i = 0; i < 500; i++) {
      node = { type: "paragraph", content: [node] };
    }
    expect(() => tiptapToPlainText(node)).not.toThrow();
  });
});
